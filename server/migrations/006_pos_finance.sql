-- =====================================================================
-- 006 Finance core (double-entry ledger, periods) and point of sale
-- =====================================================================

ALTER TYPE stock_movement_type ADD VALUE 'sale';
ALTER TYPE stock_movement_type ADD VALUE 'sale_void';

CREATE OR REPLACE FUNCTION inv.movement_direction(p_type stock_movement_type) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type::text
    WHEN 'opening_balance' THEN 'in' WHEN 'adjustment_in' THEN 'in' WHEN 'receipt' THEN 'in' WHEN 'inter_unit_in' THEN 'in'
    WHEN 'sale_void' THEN 'in'
    WHEN 'adjustment_out' THEN 'out' WHEN 'issue' THEN 'out' WHEN 'wastage' THEN 'out' WHEN 'inter_unit_out' THEN 'out'
    WHEN 'sale' THEN 'out'
    WHEN 'transfer' THEN 'move'
  END
$$;

CREATE SCHEMA fin;
CREATE SCHEMA pos;
REVOKE ALL ON SCHEMA fin, pos FROM PUBLIC;
GRANT USAGE ON SCHEMA fin, pos TO giddy_app;

-- =====================================================================
-- Chart of accounts (one per business unit), periods, journals
-- =====================================================================
CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE period_status AS ENUM ('open', 'closed');

CREATE TABLE ledger_account (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  code              text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  name              text NOT NULL,
  account_type      account_type NOT NULL,
  is_system         boolean NOT NULL DEFAULT false,
  UNIQUE (business_unit_id, code),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id)
);

CREATE TABLE fiscal_period (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  status            period_status NOT NULL DEFAULT 'open',
  closed_by         uuid REFERENCES app_user(id),
  closed_at         timestamptz,
  UNIQUE (business_unit_id, period_start),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  CHECK (period_end >= period_start)
);

CREATE TABLE journal_entry (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  period_id         uuid NOT NULL,
  entry_date        date NOT NULL,
  source_doc_type   text NOT NULL,
  source_doc_id     text,
  memo              text NOT NULL DEFAULT '',
  reverses_entry_id bigint REFERENCES journal_entry(id),
  posted_by         uuid REFERENCES app_user(id),
  posted_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (period_id, business_unit_id) REFERENCES fiscal_period(id, business_unit_id)
);
CREATE INDEX ON journal_entry (business_unit_id, id DESC);
CREATE INDEX ON journal_entry (source_doc_type, source_doc_id);

CREATE TABLE journal_line (
  id                            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id                     uuid NOT NULL,
  business_unit_id              uuid NOT NULL,
  journal_entry_id              bigint NOT NULL,
  account_id                    uuid NOT NULL,
  debit                         numeric(16, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit                        numeric(16, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  counterparty_business_unit_id uuid REFERENCES business_unit(id),  -- for inter-unit receivable / payable
  CHECK ((debit > 0) <> (credit > 0)),
  FOREIGN KEY (journal_entry_id, business_unit_id) REFERENCES journal_entry(id, business_unit_id),
  FOREIGN KEY (account_id, business_unit_id) REFERENCES ledger_account(id, business_unit_id)
);
CREATE INDEX ON journal_line (account_id);
CREATE INDEX ON journal_line (journal_entry_id);

CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();

-- Every entry must balance. Checked at commit, after all its lines exist.
CREATE FUNCTION fin.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_dr numeric; v_cr numeric;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO v_dr, v_cr
    FROM journal_line WHERE journal_entry_id = NEW.journal_entry_id;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits % credits %', NEW.journal_entry_id, v_dr, v_cr
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fin.check_entry_balanced();

-- Standard accounts every unit gets. Postings refer to them by code.
CREATE FUNCTION fin.ensure_chart(p_bu uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO ledger_account (tenant_id, business_unit_id, code, name, account_type, is_system)
  SELECT bu.tenant_id, bu.id, a.code, a.name, a.t::account_type, true
    FROM business_unit bu,
         (VALUES ('1000', 'Cash on hand', 'asset'), ('1010', 'Card / POS clearing', 'asset'),
                 ('1020', 'Bank', 'asset'), ('1150', 'Due from other units', 'asset'),
                 ('1200', 'Inventory', 'asset'),
                 ('2000', 'Accounts payable (suppliers)', 'liability'), ('2100', 'VAT payable', 'liability'),
                 ('2200', 'Due to other units', 'liability'),
                 ('3000', 'Opening balance equity', 'equity'),
                 ('4000', 'Sales revenue', 'revenue'), ('4100', 'Service charge income', 'revenue'),
                 ('5000', 'Cost of goods sold', 'expense'), ('5100', 'Stock write-offs (wastage)', 'expense'),
                 ('5200', 'Stock adjustments', 'expense'), ('5300', 'Stock used internally', 'expense')) AS a(code, name, t)
   WHERE bu.id = p_bu
  ON CONFLICT (business_unit_id, code) DO NOTHING
$$;

CREATE FUNCTION fin.business_unit_chart() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fin.ensure_chart(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER business_unit_chart AFTER INSERT ON business_unit FOR EACH ROW EXECUTE FUNCTION fin.business_unit_chart();
SELECT fin.ensure_chart(id) FROM business_unit;

-- The open monthly period containing a date (created on first use). Closed periods refuse postings.
CREATE FUNCTION fin.open_period(p_bu uuid, p_date date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_status period_status; v_start date := date_trunc('month', p_date)::date;
BEGIN
  INSERT INTO fiscal_period (tenant_id, business_unit_id, period_start, period_end)
  SELECT tenant_id, id, v_start, (v_start + interval '1 month' - interval '1 day')::date FROM business_unit WHERE id = p_bu
  ON CONFLICT (business_unit_id, period_start) DO NOTHING;
  SELECT id, status INTO v_id, v_status FROM fiscal_period WHERE business_unit_id = p_bu AND period_start = v_start;
  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'the period % is closed; nothing more can be posted to it', to_char(v_start, 'Mon YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_id;
END $$;

-- Posts a balanced entry. Lines: [{"code": "1000", "debit": n} | {"code": "4000", "credit": n, "counterparty": uuid?}]
-- Zero lines are skipped; an entry with no non-zero lines is not created (returns NULL).
CREATE FUNCTION fin.post_entry(p_bu uuid, p_date date, p_source_type text, p_source_id text, p_memo text,
                               p_lines jsonb, p_reverses bigint DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entry   bigint;
  v_tenant  uuid;
  v_line    jsonb;
  v_account uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) x
                  WHERE round(coalesce((x->>'debit')::numeric, 0), 2) > 0 OR round(coalesce((x->>'credit')::numeric, 0), 2) > 0) THEN
    RETURN NULL;
  END IF;
  SELECT tenant_id INTO v_tenant FROM business_unit WHERE id = p_bu;
  INSERT INTO journal_entry (tenant_id, business_unit_id, period_id, entry_date, source_doc_type, source_doc_id, memo,
                             reverses_entry_id, posted_by)
  VALUES (v_tenant, p_bu, fin.open_period(p_bu, p_date), p_date, p_source_type, p_source_id, coalesce(p_memo, ''),
          p_reverses, sec.current_user_id())
  RETURNING id INTO v_entry;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    CONTINUE WHEN round(coalesce((v_line->>'debit')::numeric, 0), 2) = 0 AND round(coalesce((v_line->>'credit')::numeric, 0), 2) = 0;
    SELECT id INTO v_account FROM ledger_account WHERE business_unit_id = p_bu AND code = v_line->>'code';
    IF v_account IS NULL THEN RAISE EXCEPTION 'no account % in this unit', v_line->>'code'; END IF;
    INSERT INTO journal_line (tenant_id, business_unit_id, journal_entry_id, account_id, debit, credit, counterparty_business_unit_id)
    VALUES (v_tenant, p_bu, v_entry, v_account,
            round(coalesce((v_line->>'debit')::numeric, 0), 2), round(coalesce((v_line->>'credit')::numeric, 0), 2),
            nullif(v_line->>'counterparty', '')::uuid);
  END LOOP;
  RETURN v_entry;
END $$;

-- Reverses an entry line for line (debits ↔ credits), in the current open period.
CREATE FUNCTION fin.reverse_entry(p_entry bigint, p_source_type text, p_source_id text, p_memo text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e journal_entry%ROWTYPE;
BEGIN
  SELECT * INTO e FROM journal_entry WHERE id = p_entry;
  RETURN fin.post_entry(e.business_unit_id, current_date, p_source_type, p_source_id, p_memo,
    (SELECT jsonb_agg(jsonb_build_object('code', a.code, 'debit', l.credit, 'credit', l.debit,
                                         'counterparty', l.counterparty_business_unit_id))
       FROM journal_line l JOIN ledger_account a ON a.id = l.account_id WHERE l.journal_entry_id = p_entry),
    p_entry);
END $$;

-- =====================================================================
-- Stock movements post to the ledger automatically.
-- =====================================================================
CREATE FUNCTION fin.journal_for_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_amount numeric := round(NEW.qty * coalesce(NEW.unit_cost, 0), 2);
  v_dr text; v_cr text; v_cp uuid;
  t inter_unit_transfer%ROWTYPE;
BEGIN
  IF v_amount = 0 OR NEW.movement_type = 'transfer' THEN RETURN NULL; END IF;
  CASE NEW.movement_type::text
    WHEN 'opening_balance' THEN v_dr := '1200'; v_cr := '3000';
    WHEN 'receipt'         THEN v_dr := '1200'; v_cr := '2000';
    WHEN 'adjustment_in'   THEN v_dr := '1200'; v_cr := '5200';
    WHEN 'adjustment_out'  THEN v_dr := '5200'; v_cr := '1200';
    WHEN 'wastage'         THEN v_dr := '5100'; v_cr := '1200';
    WHEN 'issue'           THEN v_dr := '5300'; v_cr := '1200';
    WHEN 'sale'            THEN v_dr := '5000'; v_cr := '1200';
    WHEN 'sale_void'       THEN v_dr := '1200'; v_cr := '5000';
    WHEN 'inter_unit_out'  THEN
      SELECT * INTO t FROM inter_unit_transfer WHERE id = NEW.source_doc_id::uuid;
      v_dr := '1150'; v_cr := '1200'; v_cp := t.to_business_unit_id;
    WHEN 'inter_unit_in'   THEN
      SELECT * INTO t FROM inter_unit_transfer WHERE id = NEW.source_doc_id::uuid;
      IF NEW.business_unit_id = t.to_business_unit_id THEN
        v_dr := '1200'; v_cr := '2200'; v_cp := t.from_business_unit_id;   -- received: we owe the sender
      ELSE
        v_dr := '1200'; v_cr := '1150'; v_cp := t.to_business_unit_id;     -- refused and put back: claim cancelled
      END IF;
    ELSE RETURN NULL;
  END CASE;
  PERFORM fin.post_entry(NEW.business_unit_id, NEW.posted_at::date, 'stock_movement', NEW.id::text,
    replace(NEW.movement_type::text, '_', ' '),
    jsonb_build_array(jsonb_build_object('code', v_dr, 'debit', v_amount, 'counterparty', CASE WHEN v_dr IN ('1150', '2200') THEN v_cp END),
                      jsonb_build_object('code', v_cr, 'credit', v_amount, 'counterparty', CASE WHEN v_cr IN ('1150', '2200') THEN v_cp END)));
  RETURN NULL;
END $$;
CREATE TRIGGER journal AFTER INSERT ON stock_movement FOR EACH ROW EXECUTE FUNCTION fin.journal_for_movement();

-- Month-end: the owner (or partner, for the Spa) closes a period. Closed periods cannot be reopened.
CREATE FUNCTION fin.close_period(p_period uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p fiscal_period%ROWTYPE;
BEGIN
  SELECT * INTO p FROM fiscal_period WHERE id = p_period AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'period not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT (sec.has_scope(p.business_unit_id, 'FIN', true) AND sec.has_scope(p.business_unit_id, 'CFG', true)) THEN
    RAISE EXCEPTION 'only the owner of this unit''s books can close a period' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p.status = 'closed' THEN RAISE EXCEPTION 'already closed' USING ERRCODE = 'check_violation'; END IF;
  IF p.period_end >= current_date THEN
    RAISE EXCEPTION 'a period can only be closed after it ends (%)', p.period_end USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM fiscal_period WHERE business_unit_id = p.business_unit_id AND status = 'open'
               AND period_start < p.period_start) THEN
    RAISE EXCEPTION 'close earlier periods first' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE fiscal_period SET status = 'closed', closed_by = sec.current_user_id(), closed_at = now() WHERE id = p_period;
END $$;

-- =====================================================================
-- Point of sale
-- =====================================================================
CREATE TYPE ticket_status AS ENUM ('completed', 'voided');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'transfer');

CREATE TABLE sale_ticket (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  business_unit_id      uuid NOT NULL,
  department_id         uuid NOT NULL,
  location_id           uuid,
  ticket_number         text NOT NULL,
  status                ticket_status NOT NULL DEFAULT 'completed',
  customer_id           uuid,
  seller_id             uuid NOT NULL REFERENCES app_user(id),
  subtotal              numeric(16, 2) NOT NULL,
  discount_pct          numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  discount_amount       numeric(16, 2) NOT NULL DEFAULT 0,
  service_charge_pct    numeric(5, 2) NOT NULL DEFAULT 0,
  service_charge_amount numeric(16, 2) NOT NULL DEFAULT 0,
  tax_pct               numeric(5, 2) NOT NULL DEFAULT 0,
  tax_amount            numeric(16, 2) NOT NULL DEFAULT 0,
  total                 numeric(16, 2) NOT NULL CHECK (total >= 0),
  amount_paid           numeric(16, 2) NOT NULL,
  change_due            numeric(16, 2) NOT NULL DEFAULT 0 CHECK (change_due >= 0),
  note                  text NOT NULL DEFAULT '',
  journal_entry_id      bigint REFERENCES journal_entry(id),
  is_final              boolean NOT NULL DEFAULT false,   -- set at the end of checkout; afterwards only a void may change it
  created_at            timestamptz NOT NULL DEFAULT now(),
  voided_by             uuid REFERENCES app_user(id),
  voided_at             timestamptz,
  void_reason           text,
  void_journal_entry_id bigint REFERENCES journal_entry(id),
  UNIQUE (business_unit_id, ticket_number),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (department_id, business_unit_id) REFERENCES department(id, business_unit_id),
  FOREIGN KEY (location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customer(id, tenant_id),
  CHECK (amount_paid - change_due = total),
  CHECK (status = 'completed' OR (voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE INDEX ON sale_ticket (business_unit_id, created_at DESC);
CREATE INDEX ON sale_ticket (seller_id, created_at DESC);

CREATE TABLE sale_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  sale_ticket_id    uuid NOT NULL,
  line_no           integer NOT NULL,
  item_id           uuid NOT NULL,
  qty               numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_price        numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  line_total        numeric(16, 2) NOT NULL,
  cost_amount       numeric(16, 2) NOT NULL DEFAULT 0,
  movement_ids      bigint[] NOT NULL DEFAULT '{}',
  UNIQUE (sale_ticket_id, line_no),
  FOREIGN KEY (sale_ticket_id, business_unit_id) REFERENCES sale_ticket(id, business_unit_id),
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id)
);

CREATE TABLE sale_payment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  sale_ticket_id    uuid NOT NULL,
  method            payment_method NOT NULL,
  amount            numeric(16, 2) NOT NULL CHECK (amount > 0),
  reference         text,
  FOREIGN KEY (sale_ticket_id, business_unit_id) REFERENCES sale_ticket(id, business_unit_id)
);

-- Lines and payments never change; a ticket changes only once, from completed to voided.
CREATE TRIGGER sale_line_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON sale_line
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();
CREATE TRIGGER sale_payment_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON sale_payment
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();
CREATE FUNCTION pos.ticket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'sale tickets cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NOT OLD.is_final THEN RETURN NEW; END IF;   -- still inside its own checkout transaction
  IF OLD.status <> 'completed' OR NEW.status <> 'voided'
     OR (to_jsonb(NEW) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason', 'void_journal_entry_id'])
        <> (to_jsonb(OLD) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason', 'void_journal_entry_id']) THEN
    RAISE EXCEPTION 'a sale ticket can only be voided, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sale_ticket_guard BEFORE UPDATE OR DELETE ON sale_ticket FOR EACH ROW EXECUTE FUNCTION pos.ticket_guard();

-- Can the current user ring up sales in this department?
-- Needs fin.write through an assignment that covers the department: unit-wide, this department,
-- or tenant-wide in an owner-managed unit. A cashier assigned to the Bar cannot sell in the Kitchen.
CREATE FUNCTION sec.can_sell(p_bu uuid, p_dept uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_role_assignment a
      JOIN role_permission rp ON rp.role_id = a.role_id AND rp.permission_code = 'fin.write'
      JOIN business_unit bu ON bu.id = p_bu
     WHERE a.user_id = sec.current_user_id() AND a.status = 'active' AND a.tenant_id = sec.current_tenant_id()
       AND ((a.business_unit_id = p_bu AND (a.department_id IS NULL OR a.department_id = p_dept))
            OR (a.business_unit_id IS NULL AND bu.management_model = 'owner')))
$$;

CREATE FUNCTION pos.setting_pct(p_bu uuid, p_key text, p_default numeric) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT (value #>> '{}')::numeric FROM business_unit_setting WHERE business_unit_id = p_bu AND key = p_key), p_default)
$$;

-- Totals: subtotal − discount = net; service charge on net; VAT on (net + service charge).
-- Prices always come from the unit's price list: the till cannot override them.
-- Lines:    [{"itemId": uuid, "qty": n}]
-- Payments: [{"method": "cash"|"card"|"transfer", "amount": n, "reference": text?}]
CREATE FUNCTION pos.checkout(p_bu uuid, p_department uuid, p_location uuid, p_customer uuid, p_discount_pct numeric,
                             p_lines jsonb, p_payments jsonb, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant    uuid := sec.current_tenant_id();
  v_ticket    uuid;
  v_number    text;
  v_line      jsonb;
  v_pay       jsonb;
  v_no        integer := 0;
  v_item      record;
  v_qty       numeric;
  v_subtotal  numeric := 0;
  v_discount  numeric;
  v_net       numeric;
  v_svc_pct   numeric := pos.setting_pct(p_bu, 'charges.service_pct', 0);
  v_tax_pct   numeric := pos.setting_pct(p_bu, 'tax.vat_pct', 0);
  v_svc       numeric;
  v_tax       numeric;
  v_total     numeric;
  v_paid      numeric := 0;
  v_noncash   numeric := 0;
  v_cash      numeric := 0;
  v_change    numeric;
  v_moves     bigint[];
  v_cost      numeric;
  v_line_id   uuid;
  v_entry     bigint;
BEGIN
  IF NOT sec.can_sell(p_bu, p_department) THEN
    RAISE EXCEPTION 'you cannot sell in this department' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM department WHERE id = p_department AND business_unit_id = p_bu AND is_active) THEN
    RAISE EXCEPTION 'department is not an active department of this unit' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'the ticket is empty' USING ERRCODE = 'check_violation';
  END IF;
  p_discount_pct := coalesce(p_discount_pct, 0);
  IF p_discount_pct < 0 OR p_discount_pct > 100 THEN
    RAISE EXCEPTION 'discount must be between 0 and 100 percent' USING ERRCODE = 'check_violation';
  END IF;
  IF p_discount_pct > pos.setting_pct(p_bu, 'pos.max_discount_pct', 10) AND NOT sec.has_scope(p_bu, 'CFG', true) THEN
    RAISE EXCEPTION '%', format('discounts above %s%% need a manager', trim_scale(pos.setting_pct(p_bu, 'pos.max_discount_pct', 10)))
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_number := inv.next_doc_number(p_bu, 'TKT');
  INSERT INTO sale_ticket (tenant_id, business_unit_id, department_id, location_id, ticket_number, customer_id, seller_id,
                           subtotal, discount_pct, service_charge_pct, tax_pct, total, amount_paid, note)
  VALUES (v_tenant, p_bu, p_department, p_location, v_number, p_customer, sec.current_user_id(),
          0, p_discount_pct, v_svc_pct, v_tax_pct, 0, 0, coalesce(p_note, ''))
  RETURNING id INTO v_ticket;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_no := v_no + 1;
    v_qty := (v_line->>'qty')::numeric;
    SELECT i.id, i.name, i.is_stockable, bui.sell_price INTO v_item
      FROM item i JOIN business_unit_item bui ON bui.item_id = i.id AND bui.business_unit_id = p_bu AND bui.is_active
     WHERE i.id = (v_line->>'itemId')::uuid AND i.is_active AND i.is_sellable;
    IF NOT FOUND THEN RAISE EXCEPTION 'line %: item is not on sale in this unit', v_no USING ERRCODE = 'check_violation'; END IF;
    IF v_item.sell_price IS NULL THEN RAISE EXCEPTION '% has no price set', v_item.name USING ERRCODE = 'check_violation'; END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'line %: quantity must be above zero', v_no USING ERRCODE = 'check_violation'; END IF;

    v_moves := '{}';
    v_cost := 0;
    IF v_item.is_stockable THEN
      IF p_location IS NULL THEN RAISE EXCEPTION 'choose the store this till sells from' USING ERRCODE = 'check_violation'; END IF;
      SELECT array_agg(mv.id) INTO v_moves
        FROM inv.apply_movement(p_bu, 'sale', v_item.id, v_qty, p_location, NULL, NULL, NULL, NULL, NULL, NULL,
                                v_number, 'sale_ticket', v_ticket::text) AS mv(id);
      SELECT coalesce(sum(round(qty * coalesce(unit_cost, 0), 2)), 0) INTO v_cost FROM stock_movement WHERE id = ANY (v_moves);
    END IF;
    INSERT INTO sale_line (tenant_id, business_unit_id, sale_ticket_id, line_no, item_id, qty, unit_price, line_total,
                           cost_amount, movement_ids)
    VALUES (v_tenant, p_bu, v_ticket, v_no, v_item.id, v_qty, v_item.sell_price, round(v_qty * v_item.sell_price, 2),
            v_cost, v_moves);
    v_subtotal := v_subtotal + round(v_qty * v_item.sell_price, 2);
  END LOOP;

  v_discount := round(v_subtotal * p_discount_pct / 100, 2);
  v_net      := v_subtotal - v_discount;
  v_svc      := round(v_net * v_svc_pct / 100, 2);
  v_tax      := round((v_net + v_svc) * v_tax_pct / 100, 2);
  v_total    := v_net + v_svc + v_tax;

  IF jsonb_typeof(p_payments) <> 'array' OR jsonb_array_length(p_payments) = 0 THEN
    RAISE EXCEPTION 'record how the customer paid' USING ERRCODE = 'check_violation';
  END IF;
  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payments) LOOP
    IF (v_pay->>'amount')::numeric IS NULL OR (v_pay->>'amount')::numeric <= 0 THEN
      RAISE EXCEPTION 'payment amounts must be above zero' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO sale_payment (tenant_id, business_unit_id, sale_ticket_id, method, amount, reference)
    VALUES (v_tenant, p_bu, v_ticket, (v_pay->>'method')::payment_method, round((v_pay->>'amount')::numeric, 2),
            nullif(trim(v_pay->>'reference'), ''));
    v_paid := v_paid + round((v_pay->>'amount')::numeric, 2);
    IF v_pay->>'method' = 'cash' THEN v_cash := v_cash + round((v_pay->>'amount')::numeric, 2);
    ELSE v_noncash := v_noncash + round((v_pay->>'amount')::numeric, 2); END IF;
  END LOOP;
  IF v_paid < v_total THEN
    RAISE EXCEPTION 'payment of % is short of the total %', v_paid, v_total USING ERRCODE = 'check_violation';
  END IF;
  IF v_noncash > v_total THEN
    RAISE EXCEPTION 'card and transfer payments cannot exceed the total (change is only given from cash)' USING ERRCODE = 'check_violation';
  END IF;
  v_change := v_paid - v_total;


  -- Money in by method (cash net of change), revenue net of discount, service charge, VAT.
  v_entry := fin.post_entry(p_bu, current_date, 'sale_ticket', v_ticket::text, v_number, jsonb_build_array(
    jsonb_build_object('code', '1000', 'debit', v_cash - v_change),
    jsonb_build_object('code', '1010', 'debit', (SELECT coalesce(sum(amount), 0) FROM sale_payment WHERE sale_ticket_id = v_ticket AND method = 'card')),
    jsonb_build_object('code', '1020', 'debit', (SELECT coalesce(sum(amount), 0) FROM sale_payment WHERE sale_ticket_id = v_ticket AND method = 'transfer')),
    jsonb_build_object('code', '4000', 'credit', v_net),
    jsonb_build_object('code', '4100', 'credit', v_svc),
    jsonb_build_object('code', '2100', 'credit', v_tax)));
  UPDATE sale_ticket SET subtotal = v_subtotal, discount_amount = v_discount, service_charge_amount = v_svc,
         tax_amount = v_tax, total = v_total, amount_paid = v_paid, change_due = v_change,
         journal_entry_id = v_entry, is_final = true
   WHERE id = v_ticket;
  RETURN v_ticket;
END $$;

-- Void: the owner of the unit's books only (FIN write + CFG write), with a reason.
-- Stock goes back to the same batches at the original cost; the sale's journal entry is reversed.
CREATE FUNCTION pos.void_ticket(p_ticket uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t     sale_ticket%ROWTYPE;
  m     record;
  v_rev bigint;
BEGIN
  SELECT * INTO t FROM sale_ticket WHERE id = p_ticket AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(t.business_unit_id, 'FIN') THEN
    RAISE EXCEPTION 'ticket not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (sec.has_scope(t.business_unit_id, 'FIN', true) AND sec.has_scope(t.business_unit_id, 'CFG', true)) THEN
    RAISE EXCEPTION 'only the owner of this unit''s books can void a sale' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF t.status = 'voided' THEN RAISE EXCEPTION 'this sale is already voided' USING ERRCODE = 'check_violation'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'give a reason for the void' USING ERRCODE = 'check_violation'; END IF;

  FOR m IN SELECT sm.* FROM sale_line l JOIN stock_movement sm ON sm.id = ANY (l.movement_ids)
            WHERE l.sale_ticket_id = p_ticket ORDER BY sm.id LOOP
    PERFORM inv.apply_movement(t.business_unit_id, 'sale_void', m.item_id, m.qty, NULL, m.from_location_id, m.batch_id,
                               NULL, NULL, NULL, coalesce(m.unit_cost, 0), 'void ' || t.ticket_number,
                               'sale_ticket', p_ticket::text);
  END LOOP;
  IF t.journal_entry_id IS NOT NULL THEN
    v_rev := fin.reverse_entry(t.journal_entry_id, 'sale_void', p_ticket::text, 'void ' || t.ticket_number || ': ' || p_reason);
  END IF;
  UPDATE sale_ticket SET status = 'voided', voided_by = sec.current_user_id(), voided_at = now(),
         void_reason = p_reason, void_journal_entry_id = v_rev WHERE id = p_ticket;
END $$;

-- =====================================================================
-- Audit, row-level security, grants
-- =====================================================================
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON sale_ticket   FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON sale_line               FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON sale_payment            FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON journal_entry           FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON fiscal_period FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

ALTER TABLE ledger_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_period  ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entry  ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_line   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_ticket    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_line      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_payment   ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_read ON ledger_account FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY period_read ON fiscal_period FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY entry_read ON journal_entry FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY line_read ON journal_line FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY ticket_read ON sale_ticket FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY sale_line_read ON sale_line FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY sale_payment_read ON sale_payment FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));

GRANT SELECT ON ledger_account, fiscal_period, journal_entry, journal_line, sale_ticket, sale_line, sale_payment TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fin FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pos FROM PUBLIC;
REVOKE ALL ON FUNCTION sec.can_sell(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sec.can_sell(uuid, uuid), fin.close_period(uuid),
  pos.checkout(uuid, uuid, uuid, uuid, numeric, jsonb, jsonb, text), pos.void_ticket(uuid, text)
TO giddy_app;
