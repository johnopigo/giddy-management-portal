-- =====================================================================
-- 010 Appointment bills (Content Studio first, the Spa next):
--     deposits, add-ons from the catalogue (stock items leave the store),
--     the booking charged on completion, payments, refunds, cancellation fees,
--     and extending a hire while it runs.
--
-- The bill follows the guest-folio pattern: entries are permanent and signed
-- (charges +, payments −); the balance is their sum; every entry is posted to the books.
--   charges  Dr 1100 Client ledger   Cr 4300 Bookings revenue / 4000 Sales / 4100 / 2100
--   payment  Dr 1000/1010/1020       Cr 1100
-- =====================================================================

-- Chart: bookings revenue, and the guest ledger now holds appointment bills as well.
CREATE OR REPLACE FUNCTION fin.ensure_chart(p_bu uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO ledger_account (tenant_id, business_unit_id, code, name, account_type, is_system)
  SELECT bu.tenant_id, bu.id, a.code, a.name, a.t::account_type, true
    FROM business_unit bu,
         (VALUES ('1000', 'Cash on hand', 'asset'), ('1010', 'Card / POS clearing', 'asset'),
                 ('1020', 'Bank', 'asset'), ('1100', 'Guest ledger (open folios)', 'asset'),
                 ('1150', 'Due from other units', 'asset'),
                 ('1200', 'Inventory', 'asset'), ('1250', 'Production in progress', 'asset'),
                 ('2000', 'Accounts payable (suppliers)', 'liability'), ('2100', 'VAT payable', 'liability'),
                 ('2200', 'Due to other units', 'liability'),
                 ('3000', 'Opening balance equity', 'equity'),
                 ('4000', 'Sales revenue', 'revenue'), ('4100', 'Service charge income', 'revenue'),
                 ('4200', 'Room revenue', 'revenue'), ('4300', 'Bookings revenue', 'revenue'),
                 ('5000', 'Cost of goods sold', 'expense'), ('5100', 'Stock write-offs (wastage)', 'expense'),
                 ('5200', 'Stock adjustments', 'expense'), ('5300', 'Stock used internally', 'expense')) AS a(code, name, t)
   WHERE bu.id = p_bu
  ON CONFLICT (business_unit_id, code) DO NOTHING
$$;
SELECT fin.ensure_chart(id) FROM business_unit;
UPDATE ledger_account SET name = 'Guest & client ledger (open bills)' WHERE code = '1100' AND is_system;

-- Deposit asked for at booking, as a percentage of the booking price.
ALTER TABLE bookable_service ADD COLUMN deposit_pct numeric(5, 2) NOT NULL DEFAULT 0 CHECK (deposit_pct BETWEEN 0 AND 100);
GRANT UPDATE (deposit_pct) ON bookable_service TO giddy_app;
ALTER TABLE appointment ADD COLUMN deposit_due numeric(14, 2) NOT NULL DEFAULT 0 CHECK (deposit_due >= 0);

-- =====================================================================
-- Bills
-- =====================================================================
CREATE TYPE bill_status AS ENUM ('open', 'closed');
CREATE TYPE bill_entry_type AS ENUM ('booking', 'addon', 'service_charge', 'tax', 'payment', 'refund', 'fee', 'adjustment');

CREATE TABLE appointment_bill (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  bill_number       text NOT NULL,
  appointment_id    uuid NOT NULL UNIQUE,
  status            bill_status NOT NULL DEFAULT 'open',
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  UNIQUE (business_unit_id, bill_number),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (appointment_id, business_unit_id) REFERENCES appointment(id, business_unit_id)
);

CREATE TABLE bill_entry (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  business_unit_id    uuid NOT NULL,
  bill_id             uuid NOT NULL,
  entry_type          bill_entry_type NOT NULL,
  description         text NOT NULL,
  amount              numeric(16, 2) NOT NULL CHECK (amount <> 0),
  item_id             uuid REFERENCES item(id),
  qty                 numeric(14, 3),
  unit_price          numeric(14, 2),
  location_id         uuid REFERENCES stock_location(id),
  movement_ids        bigint[] NOT NULL DEFAULT '{}',
  method              payment_method,
  reference           text,
  reverses_entry_id   bigint REFERENCES bill_entry(id),
  journal_entry_id    bigint REFERENCES journal_entry(id),
  posted_by           uuid NOT NULL REFERENCES app_user(id),
  posted_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (bill_id, business_unit_id) REFERENCES appointment_bill(id, business_unit_id),
  CHECK ((entry_type IN ('payment', 'refund')) = (method IS NOT NULL))
);
CREATE INDEX ON bill_entry (bill_id, id);
CREATE UNIQUE INDEX bill_entry_reversed_once ON bill_entry (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE TRIGGER bill_entry_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON bill_entry
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();

CREATE FUNCTION bk.bill_balance(p_bill uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(amount), 0) FROM bill_entry WHERE bill_id = p_bill
$$;

-- What the guest has paid so far (payments less refunds).
CREATE FUNCTION bk.bill_paid(p_bill uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(-sum(amount), 0) FROM bill_entry WHERE bill_id = p_bill AND entry_type IN ('payment', 'refund')
$$;

-- Money summary of an appointment's bill (callers show it only to finance readers).
CREATE FUNCTION bk.bill_money(p_appt uuid, OUT paid numeric, OUT balance numeric, OUT bill_status bill_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT bk.bill_paid(b.id), bk.bill_balance(b.id), b.status FROM appointment_bill b
   WHERE b.appointment_id = p_appt AND sec.has_scope(b.business_unit_id, 'FIN')
$$;

-- Price with service charge and VAT, at the unit's current rates.
CREATE FUNCTION bk.gross(p_bu uuid, p_net numeric) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_net + round(p_net * pos.setting_pct(p_bu, 'charges.service_pct', 0) / 100, 2)
       + round((p_net + round(p_net * pos.setting_pct(p_bu, 'charges.service_pct', 0) / 100, 2))
               * pos.setting_pct(p_bu, 'tax.vat_pct', 0) / 100, 2)
$$;

-- Every appointment gets a bill; the deposit follows the price.
CREATE FUNCTION bk.appointment_deposit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.deposit_due := round(NEW.price * (SELECT deposit_pct FROM bookable_service WHERE id = NEW.service_id) / 100, 2);
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_deposit BEFORE INSERT OR UPDATE OF price ON appointment
  FOR EACH ROW EXECUTE FUNCTION bk.appointment_deposit();

CREATE FUNCTION bk.appointment_bill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO appointment_bill (tenant_id, business_unit_id, bill_number, appointment_id)
  VALUES (NEW.tenant_id, NEW.business_unit_id, inv.next_doc_number(NEW.business_unit_id, 'BIL'), NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER appointment_bill AFTER INSERT ON appointment FOR EACH ROW EXECUTE FUNCTION bk.appointment_bill();

-- Bills for appointments booked before this migration.
INSERT INTO appointment_bill (tenant_id, business_unit_id, bill_number, appointment_id)
SELECT a.tenant_id, a.business_unit_id, inv.next_doc_number(a.business_unit_id, 'BIL'), a.id FROM appointment a ORDER BY a.created_at;

-- Posts a charge, its service charge and VAT, to the bill and the books. Returns the first entry.
CREATE FUNCTION bk.post_charge(p_bill uuid, p_type bill_entry_type, p_description text, p_net numeric, p_revenue_code text,
                               p_item uuid DEFAULT NULL, p_qty numeric DEFAULT NULL, p_unit_price numeric DEFAULT NULL,
                               p_location uuid DEFAULT NULL, p_moves bigint[] DEFAULT '{}') RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b       appointment_bill%ROWTYPE;
  v_svc   numeric;
  v_tax   numeric;
  v_je    bigint;
  v_first bigint;
BEGIN
  SELECT * INTO b FROM appointment_bill WHERE id = p_bill;
  v_svc := round(p_net * pos.setting_pct(b.business_unit_id, 'charges.service_pct', 0) / 100, 2);
  v_tax := round((p_net + v_svc) * pos.setting_pct(b.business_unit_id, 'tax.vat_pct', 0) / 100, 2);
  v_je := fin.post_entry(b.business_unit_id, current_date, 'appointment_bill', p_bill::text, p_description, jsonb_build_array(
    jsonb_build_object('code', '1100', 'debit', p_net + v_svc + v_tax),
    jsonb_build_object('code', p_revenue_code, 'credit', p_net),
    jsonb_build_object('code', '4100', 'credit', v_svc),
    jsonb_build_object('code', '2100', 'credit', v_tax)));
  INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, item_id, qty, unit_price,
                          location_id, movement_ids, journal_entry_id, posted_by)
  VALUES (b.tenant_id, b.business_unit_id, p_bill, p_type, p_description, p_net, p_item, p_qty, p_unit_price,
          p_location, coalesce(p_moves, '{}'), v_je, sec.current_user_id())
  RETURNING id INTO v_first;
  IF v_svc <> 0 THEN
    INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, journal_entry_id, posted_by)
    VALUES (b.tenant_id, b.business_unit_id, p_bill, 'service_charge', 'Service charge · ' || p_description, v_svc, v_je, sec.current_user_id());
  END IF;
  IF v_tax <> 0 THEN
    INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, journal_entry_id, posted_by)
    VALUES (b.tenant_id, b.business_unit_id, p_bill, 'tax', 'VAT · ' || p_description, v_tax, v_je, sec.current_user_id());
  END IF;
  RETURN v_first;
END $$;

-- Closes the bill once the appointment is over and nothing is owed either way.
CREATE FUNCTION bk.maybe_close(p_bill uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE appointment_bill b SET status = 'closed', closed_at = now()
   WHERE b.id = p_bill AND b.status = 'open' AND bk.bill_balance(b.id) = 0
     AND (SELECT status FROM appointment WHERE id = b.appointment_id) IN ('completed', 'cancelled', 'no_show')
$$;

-- Locks a bill for a money action. Taking money needs FIN write.
CREATE FUNCTION bk.lock_bill(p_appt uuid) RETURNS appointment_bill
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b appointment_bill%ROWTYPE;
BEGIN
  SELECT bl.* INTO b FROM appointment_bill bl JOIN appointment a ON a.id = bl.appointment_id
   WHERE bl.appointment_id = p_appt AND a.tenant_id = sec.current_tenant_id() FOR UPDATE OF bl;
  IF NOT FOUND OR NOT sec.has_scope(b.business_unit_id, 'FIN') THEN
    RAISE EXCEPTION 'bill not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT sec.has_scope(b.business_unit_id, 'FIN', true) THEN
    RAISE EXCEPTION 'you cannot take payments in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF b.status <> 'open' THEN RAISE EXCEPTION 'this bill is closed' USING ERRCODE = 'check_violation'; END IF;
  RETURN b;
END $$;

-- What the guest is expected to pay in total so far: the booking (with charges) plus add-ons.
CREATE FUNCTION bk.expected_total(p_appt uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN a.status = 'completed' THEN 0 ELSE bk.gross(a.business_unit_id, a.price) END
       + coalesce((SELECT sum(e.amount) FROM bill_entry e
                    WHERE e.bill_id = b.id AND e.entry_type NOT IN ('payment', 'refund')), 0)
    FROM appointment a JOIN appointment_bill b ON b.appointment_id = a.id WHERE a.id = p_appt
$$;

--   payment    : any time the bill is open; never more than is expected in total
--   refund     : only of a credit balance
--   adjustment : a manager (FIN write + CFG write) reduces what is owed, with a reason
CREATE FUNCTION bk.bill_post(p_appt uuid, p_kind text, p_description text, p_amount numeric,
                             p_method payment_method, p_reference text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b       appointment_bill%ROWTYPE;
  v_entry bigint;
  v_je    bigint;
  v_bal   numeric;
BEGIN
  b := bk.lock_bill(p_appt);
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'enter an amount above zero' USING ERRCODE = 'check_violation'; END IF;
  p_amount := round(p_amount, 2);
  v_bal := bk.bill_balance(b.id);

  IF p_kind IN ('payment', 'refund') AND (p_method IS NULL OR p_method::text = 'room') THEN
    RAISE EXCEPTION 'choose cash, card or transfer' USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind = 'payment' THEN
    IF p_amount > bk.expected_total(p_appt) - bk.bill_paid(b.id) THEN
      RAISE EXCEPTION 'that is more than the guest owes (% at most)', greatest(bk.expected_total(p_appt) - bk.bill_paid(b.id), 0)
        USING ERRCODE = 'check_violation';
    END IF;
    v_je := fin.post_entry(b.business_unit_id, current_date, 'appointment_bill', b.id::text, 'Payment · ' || b.bill_number,
      jsonb_build_array(jsonb_build_object('code', fin.method_account(p_method), 'debit', p_amount),
                        jsonb_build_object('code', '1100', 'credit', p_amount)));
    INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, method, reference, journal_entry_id, posted_by)
    VALUES (b.tenant_id, b.business_unit_id, b.id, 'payment', coalesce(nullif(trim(p_description), ''), 'Payment'),
            -p_amount, p_method, nullif(trim(p_reference), ''), v_je, sec.current_user_id())
    RETURNING id INTO v_entry;
  ELSIF p_kind = 'refund' THEN
    IF p_amount > -v_bal THEN
      RAISE EXCEPTION 'you can only refund a credit balance (currently %)', greatest(-v_bal, 0) USING ERRCODE = 'check_violation';
    END IF;
    v_je := fin.post_entry(b.business_unit_id, current_date, 'appointment_bill', b.id::text, 'Refund · ' || b.bill_number,
      jsonb_build_array(jsonb_build_object('code', '1100', 'debit', p_amount),
                        jsonb_build_object('code', fin.method_account(p_method), 'credit', p_amount)));
    INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, method, reference, journal_entry_id, posted_by)
    VALUES (b.tenant_id, b.business_unit_id, b.id, 'refund', coalesce(nullif(trim(p_description), ''), 'Refund'),
            p_amount, p_method, nullif(trim(p_reference), ''), v_je, sec.current_user_id())
    RETURNING id INTO v_entry;
  ELSIF p_kind = 'adjustment' THEN
    IF NOT sec.has_scope(b.business_unit_id, 'CFG', true) THEN
      RAISE EXCEPTION 'adjustments need a manager' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF coalesce(trim(p_description), '') = '' THEN RAISE EXCEPTION 'give a reason for the adjustment' USING ERRCODE = 'check_violation'; END IF;
    IF p_amount > v_bal THEN RAISE EXCEPTION 'an adjustment cannot exceed the balance due' USING ERRCODE = 'check_violation'; END IF;
    v_je := fin.post_entry(b.business_unit_id, current_date, 'appointment_bill', b.id::text, 'Adjustment · ' || p_description,
      jsonb_build_array(jsonb_build_object('code', '4300', 'debit', p_amount),
                        jsonb_build_object('code', '1100', 'credit', p_amount)));
    INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, journal_entry_id, posted_by)
    VALUES (b.tenant_id, b.business_unit_id, b.id, 'adjustment', p_description, -p_amount, v_je, sec.current_user_id())
    RETURNING id INTO v_entry;
  ELSE
    RAISE EXCEPTION 'unknown bill action %', p_kind USING ERRCODE = 'check_violation';
  END IF;
  PERFORM bk.maybe_close(b.id);
  RETURN v_entry;
END $$;

-- Adds a catalogue item to the bill (equipment hire, editing, a product). A stock item leaves the
-- chosen store now (cost of goods posted by the stock engine); a recipe item uses its ingredients.
CREATE FUNCTION bk.add_addon(p_appt uuid, p_item uuid, p_qty numeric, p_location uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b       appointment_bill%ROWTYPE;
  a       appointment%ROWTYPE;
  v_item  record;
  v_rec   recipe%ROWTYPE;
  l       recipe_line%ROWTYPE;
  v_moves bigint[] := '{}';
  v_part  bigint[];
BEGIN
  b := bk.lock_bill(p_appt);
  SELECT * INTO a FROM appointment WHERE id = p_appt;
  IF a.status IN ('cancelled', 'no_show') THEN
    RAISE EXCEPTION 'this booking was %', CASE a.status WHEN 'no_show' THEN 'a no-show' ELSE 'cancelled' END USING ERRCODE = 'check_violation';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be above zero' USING ERRCODE = 'check_violation'; END IF;
  SELECT i.id, i.name, i.is_stockable, bui.sell_price INTO v_item
    FROM item i JOIN business_unit_item bui ON bui.item_id = i.id AND bui.business_unit_id = a.business_unit_id AND bui.is_active
   WHERE i.id = p_item AND i.is_active AND i.is_sellable;
  IF NOT FOUND THEN RAISE EXCEPTION 'that item is not on sale in this unit' USING ERRCODE = 'check_violation'; END IF;
  IF v_item.sell_price IS NULL THEN RAISE EXCEPTION '% has no price set', v_item.name USING ERRCODE = 'check_violation'; END IF;
  IF p_location IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_location WHERE id = p_location AND business_unit_id = a.business_unit_id) THEN
    RAISE EXCEPTION 'that store is not in this unit' USING ERRCODE = 'check_violation';
  END IF;

  IF v_item.is_stockable THEN
    IF p_location IS NULL THEN RAISE EXCEPTION 'choose the store % comes from', v_item.name USING ERRCODE = 'check_violation'; END IF;
    SELECT array_agg(mv.id) INTO v_moves
      FROM inv.apply_movement(a.business_unit_id, 'sale', v_item.id, p_qty, p_location, NULL, NULL, NULL, NULL, NULL, NULL,
                              a.booking_ref, 'appointment_bill', b.id::text) AS mv(id);
  ELSE
    SELECT * INTO v_rec FROM recipe WHERE business_unit_id = a.business_unit_id AND output_item_id = v_item.id AND is_active;
    IF FOUND THEN
      IF p_location IS NULL THEN RAISE EXCEPTION 'choose the store % is made from', v_item.name USING ERRCODE = 'check_violation'; END IF;
      FOR l IN SELECT * FROM recipe_line WHERE recipe_id = v_rec.id ORDER BY item_id LOOP
        SELECT array_agg(mv.id) INTO v_part
          FROM inv.apply_movement(a.business_unit_id, 'sale', l.item_id, round(l.qty * p_qty / v_rec.yield_qty, 3), p_location, NULL,
                                  NULL, NULL, NULL, NULL, NULL, a.booking_ref || ' · ' || v_item.name, 'appointment_bill', b.id::text) AS mv(id);
        v_moves := v_moves || v_part;
      END LOOP;
    END IF;
  END IF;

  RETURN bk.post_charge(b.id, 'addon', v_item.name || CASE WHEN p_qty <> 1 THEN ' × ' || trim_scale(p_qty) ELSE '' END,
                        round(p_qty * v_item.sell_price, 2), '4000', v_item.id, p_qty, v_item.sell_price, p_location, coalesce(v_moves, '{}'));
END $$;

-- Takes an add-on back off the bill (with its service charge and VAT) and returns any stock.
CREATE FUNCTION bk.void_addon(p_entry bigint, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  e     bill_entry%ROWTYPE;
  b     appointment_bill%ROWTYPE;
  x     bill_entry%ROWTYPE;
  m     stock_movement%ROWTYPE;
  v_rev bigint;
BEGIN
  SELECT * INTO e FROM bill_entry WHERE id = p_entry AND tenant_id = sec.current_tenant_id();
  IF NOT FOUND OR NOT sec.has_scope(e.business_unit_id, 'FIN') THEN RAISE EXCEPTION 'bill line not found' USING ERRCODE = 'no_data_found'; END IF;
  b := bk.lock_bill((SELECT appointment_id FROM appointment_bill WHERE id = e.bill_id));
  IF e.entry_type <> 'addon' OR e.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'only an add-on can be taken off the bill' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM bill_entry WHERE reverses_entry_id = e.id) THEN
    RAISE EXCEPTION 'that add-on was already taken off' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'give a reason' USING ERRCODE = 'check_violation'; END IF;

  FOR m IN SELECT * FROM stock_movement WHERE id = ANY (e.movement_ids) ORDER BY id LOOP
    PERFORM inv.apply_movement(m.business_unit_id, 'sale_void', m.item_id, m.qty, NULL, m.from_location_id, m.batch_id,
                               NULL, NULL, NULL, coalesce(m.unit_cost, 0), 'returned: ' || p_reason, 'appointment_bill', b.id::text);
  END LOOP;
  v_rev := fin.reverse_entry(e.journal_entry_id, 'appointment_bill', b.id::text, 'Removed: ' || e.description || ' (' || p_reason || ')');
  FOR x IN SELECT * FROM bill_entry WHERE journal_entry_id = e.journal_entry_id ORDER BY id LOOP
    INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, item_id, qty, unit_price,
                            reverses_entry_id, journal_entry_id, posted_by)
    VALUES (x.tenant_id, x.business_unit_id, x.bill_id, x.entry_type, 'Removed: ' || x.description || ' (' || p_reason || ')',
            -x.amount, x.item_id, CASE WHEN x.qty IS NOT NULL THEN -x.qty END, x.unit_price, x.id, v_rev, sec.current_user_id());
  END LOOP;
  PERFORM bk.maybe_close(b.id);
END $$;

-- Completing an appointment charges the booking to the bill.
CREATE OR REPLACE FUNCTION bk.complete(p_appt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE; s bookable_service%ROWTYPE; v_bill uuid;
BEGIN
  a := bk.lock_appointment(p_appt);
  IF a.status <> 'checked_in' THEN
    RAISE EXCEPTION 'check the guest in first' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO s FROM bookable_service WHERE id = a.service_id;
  IF now() < a.ends_at THEN
    UPDATE appointment_resource
       SET during = tstzrange(lower(during), greatest(now(), a.starts_at) + make_interval(mins => s.buffer_min))
     WHERE appointment_id = a.id AND is_active
       AND greatest(now(), a.starts_at) + make_interval(mins => s.buffer_min) > lower(during);
  END IF;
  UPDATE appointment SET status = 'completed', completed_by = sec.current_user_id(), completed_at = now(),
         row_version = row_version + 1 WHERE id = a.id;
  SELECT id INTO v_bill FROM appointment_bill WHERE appointment_id = a.id FOR UPDATE;
  IF a.price > 0 THEN
    PERFORM bk.post_charge(v_bill, 'booking',
      s.name || CASE WHEN a.slots > 1 THEN ' × ' || a.slots ELSE '' END || ' · ' || a.booking_ref, a.price, '4300');
  END IF;
  PERFORM bk.maybe_close(v_bill);
END $$;

-- Cancel or no-show. A paid deposit is either refunded first or kept as a cancellation fee.
DROP FUNCTION bk.cancel(uuid, text, text);
CREATE FUNCTION bk.cancel(p_appt uuid, p_action text, p_reason text, p_keep_deposit boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a appointment%ROWTYPE; b appointment_bill%ROWTYPE; v_bal numeric; v_je bigint;
BEGIN
  a := bk.lock_appointment(p_appt);
  IF p_action NOT IN ('cancelled', 'no_show') THEN RAISE EXCEPTION 'unknown action' USING ERRCODE = 'check_violation'; END IF;
  IF a.status <> 'booked' THEN
    RAISE EXCEPTION 'only a booked appointment can be %', replace(p_action, '_', '-') USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'no_show' AND now() < a.starts_at THEN
    RAISE EXCEPTION 'a guest can only be a no-show after the start time' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'cancelled' AND coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'give a reason for cancelling' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO b FROM appointment_bill WHERE appointment_id = a.id FOR UPDATE;
  v_bal := bk.bill_balance(b.id);
  IF v_bal <> 0 AND NOT sec.has_scope(a.business_unit_id, 'FIN', true) THEN
    RAISE EXCEPTION 'this booking has money on its bill; ask someone who takes payments' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_bal > 0 THEN
    RAISE EXCEPTION 'settle the bill first (% owed): take payment or remove the add-ons', v_bal USING ERRCODE = 'check_violation';
  END IF;
  IF v_bal < 0 AND NOT coalesce(p_keep_deposit, false) THEN
    RAISE EXCEPTION 'refund the deposit (%) first, or keep it as a cancellation fee', -v_bal USING ERRCODE = 'check_violation';
  END IF;

  UPDATE appointment_resource SET is_active = false WHERE appointment_id = a.id;
  UPDATE appointment SET status = p_action::appointment_status, cancelled_by = sec.current_user_id(), cancelled_at = now(),
         cancel_reason = nullif(trim(coalesce(p_reason, '')), ''), row_version = row_version + 1
   WHERE id = a.id;
  IF v_bal < 0 THEN
    v_je := fin.post_entry(a.business_unit_id, current_date, 'appointment_bill', b.id::text,
      CASE p_action WHEN 'no_show' THEN 'No-show fee · ' ELSE 'Cancellation fee · ' END || a.booking_ref, jsonb_build_array(
        jsonb_build_object('code', '1100', 'debit', -v_bal),
        jsonb_build_object('code', '4300', 'credit', -v_bal)));
    INSERT INTO bill_entry (tenant_id, business_unit_id, bill_id, entry_type, description, amount, journal_entry_id, posted_by)
    VALUES (b.tenant_id, b.business_unit_id, b.id, 'fee',
            CASE p_action WHEN 'no_show' THEN 'No-show fee (deposit kept)' ELSE 'Cancellation fee (deposit kept)' END,
            -v_bal, v_je, sec.current_user_id());
  END IF;
  PERFORM bk.maybe_close(b.id);
  IF p_action = 'cancelled' THEN PERFORM bk.notify_staff(a.id, 'Booking cancelled'); END IF;
END $$;

-- Adds slots to a slot hire (booked or under way) if the same resources are free for the extra time.
CREATE FUNCTION bk.extend(p_appt uuid, p_extra integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a      appointment%ROWTYPE;
  s      bookable_service%ROWTYPE;
  v_end  timestamptz;
  r      record;
BEGIN
  a := bk.lock_appointment(p_appt);
  SELECT * INTO s FROM bookable_service WHERE id = a.service_id;
  IF s.mode <> 'slot' THEN RAISE EXCEPTION 'only hires by the slot can be extended; move the booking instead' USING ERRCODE = 'check_violation'; END IF;
  IF a.status NOT IN ('booked', 'checked_in') THEN
    RAISE EXCEPTION 'this booking cannot be extended (it is %)', replace(a.status::text, '_', ' ') USING ERRCODE = 'check_violation';
  END IF;
  IF p_extra IS NULL OR p_extra < 1 THEN RAISE EXCEPTION 'add at least one slot' USING ERRCODE = 'check_violation'; END IF;
  IF a.slots + p_extra > s.max_slots THEN
    RAISE EXCEPTION '% can be booked for at most % slots', s.name, s.max_slots USING ERRCODE = 'check_violation';
  END IF;
  v_end := a.ends_at + make_interval(mins => s.duration_min * p_extra);
  PERFORM 1 FROM bookable_resource WHERE id IN (SELECT resource_id FROM appointment_resource WHERE appointment_id = a.id AND is_active)
   ORDER BY id FOR UPDATE;
  FOR r IN SELECT ar.resource_id, br.name FROM appointment_resource ar JOIN bookable_resource br ON br.id = ar.resource_id
            WHERE ar.appointment_id = a.id AND ar.is_active LOOP
    IF NOT bk.resource_free(r.resource_id, a.starts_at, v_end, tstzrange(a.starts_at, v_end + make_interval(mins => s.buffer_min)), a.id) THEN
      RAISE EXCEPTION '% is not free until %', r.name, bk.local_label(a.business_unit_id, v_end) USING ERRCODE = 'GD409';
    END IF;
  END LOOP;
  UPDATE appointment_resource SET during = tstzrange(a.starts_at, v_end + make_interval(mins => s.buffer_min))
   WHERE appointment_id = a.id AND is_active;
  UPDATE appointment SET ends_at = v_end, slots = a.slots + p_extra, price = s.price * (a.slots + p_extra),
         row_version = row_version + 1 WHERE id = a.id;
  PERFORM bk.notify_staff(a.id, 'Booking extended');
END $$;

CREATE TRIGGER audit AFTER INSERT OR UPDATE ON appointment_bill FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON bill_entry                 FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

ALTER TABLE appointment_bill ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_entry       ENABLE ROW LEVEL SECURITY;
CREATE POLICY bill_read ON appointment_bill FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY bill_entry_read ON bill_entry FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
GRANT SELECT ON appointment_bill, bill_entry TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bk FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  bk.book(uuid, uuid, timestamptz, integer, booking_source, text, jsonb),
  bk.reschedule(uuid, timestamptz, integer, jsonb),
  bk.check_in(uuid), bk.complete(uuid), bk.cancel(uuid, text, text, boolean), bk.extend(uuid, integer),
  bk.availability(uuid, date, integer, jsonb, uuid),
  bk.set_hours(uuid, jsonb), bk.add_block(uuid, timestamptz, timestamptz, text),
  bk.unit_people(uuid), bk.visible(uuid, uuid), bk.local_label(uuid, timestamptz),
  bk.bill_balance(uuid), bk.bill_paid(uuid), bk.bill_money(uuid), bk.gross(uuid, numeric), bk.expected_total(uuid),
  bk.bill_post(uuid, text, text, numeric, payment_method, text), bk.add_addon(uuid, uuid, numeric, uuid), bk.void_addon(bigint, text)
TO giddy_app;
