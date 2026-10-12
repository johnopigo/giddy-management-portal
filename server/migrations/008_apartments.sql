-- =====================================================================
-- 008 Luxury Apartments: rooms, rates, reservations (no double booking),
--     guest folios, night audit, housekeeping, charge-to-room from other units
-- =====================================================================

CREATE SCHEMA apt;
REVOKE ALL ON SCHEMA apt FROM PUBLIC;
GRANT USAGE ON SCHEMA apt TO giddy_app;

ALTER TYPE payment_method ADD VALUE 'room';

-- Ledger: guest ledger (open folios) and room revenue.
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
                 ('4200', 'Room revenue', 'revenue'),
                 ('5000', 'Cost of goods sold', 'expense'), ('5100', 'Stock write-offs (wastage)', 'expense'),
                 ('5200', 'Stock adjustments', 'expense'), ('5300', 'Stock used internally', 'expense')) AS a(code, name, t)
   WHERE bu.id = p_bu
  ON CONFLICT (business_unit_id, code) DO NOTHING
$$;
SELECT fin.ensure_chart(id) FROM business_unit;

-- =====================================================================
-- Rooms and rates (configuration)
-- =====================================================================
CREATE TYPE room_status AS ENUM ('available', 'occupied', 'cleaning', 'maintenance', 'out_of_order');

CREATE TABLE room_type (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  max_adults        integer NOT NULL DEFAULT 2 CHECK (max_adults > 0),
  max_children      integer NOT NULL DEFAULT 0 CHECK (max_children >= 0),
  base_rate         numeric(14, 2) NOT NULL CHECK (base_rate >= 0),
  amenities         text[] NOT NULL DEFAULT '{}',
  is_active         boolean NOT NULL DEFAULT true,
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, code),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id)
);

CREATE TABLE room (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  branch_id         uuid NOT NULL,
  room_type_id      uuid NOT NULL,
  room_number       text NOT NULL,
  floor             text,
  status            room_status NOT NULL DEFAULT 'available',
  status_note       text,
  is_active         boolean NOT NULL DEFAULT true,
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, room_number),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branch(id, tenant_id),
  FOREIGN KEY (room_type_id, business_unit_id) REFERENCES room_type(id, business_unit_id)
);

-- Seasonal / special rates. The highest-priority plan covering a night wins; otherwise the base rate.
CREATE TABLE rate_plan (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  room_type_id      uuid NOT NULL,
  name              text NOT NULL,
  date_from         date NOT NULL,
  date_to           date NOT NULL,
  nightly_rate      numeric(14, 2) NOT NULL CHECK (nightly_rate >= 0),
  priority          integer NOT NULL DEFAULT 1,
  FOREIGN KEY (room_type_id, business_unit_id) REFERENCES room_type(id, business_unit_id) ON DELETE CASCADE,
  CHECK (date_to >= date_from)
);

CREATE FUNCTION apt.nightly_rate(p_room_type uuid, p_night date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT nightly_rate FROM rate_plan WHERE room_type_id = p_room_type AND p_night BETWEEN date_from AND date_to
      ORDER BY priority DESC, date_from DESC LIMIT 1),
    (SELECT base_rate FROM room_type WHERE id = p_room_type))
$$;

-- =====================================================================
-- Reservations. Every booked room has a concrete room, and every night of it
-- is a row in room_night whose primary key (room, date) makes a double booking impossible.
-- =====================================================================
CREATE TYPE reservation_source AS ENUM ('direct', 'walk_in', 'corporate', 'travel_agent', 'online');
CREATE TYPE reservation_status AS ENUM ('confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show');

CREATE TABLE reservation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  booking_ref       text NOT NULL,
  customer_id       uuid NOT NULL,
  source            reservation_source NOT NULL DEFAULT 'direct',
  status            reservation_status NOT NULL DEFAULT 'confirmed',
  check_in          date NOT NULL,
  check_out         date NOT NULL,
  adults            integer NOT NULL DEFAULT 1 CHECK (adults > 0),
  children          integer NOT NULL DEFAULT 0 CHECK (children >= 0),
  notes             text NOT NULL DEFAULT '',
  created_by        uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  checked_in_by     uuid REFERENCES app_user(id),
  checked_in_at     timestamptz,
  checked_out_by    uuid REFERENCES app_user(id),
  checked_out_at    timestamptz,
  cancelled_by      uuid REFERENCES app_user(id),
  cancelled_at      timestamptz,
  cancel_reason     text,
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, booking_ref),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customer(id, tenant_id),
  CHECK (check_out > check_in)
);
CREATE INDEX ON reservation (business_unit_id, check_in);
CREATE INDEX ON reservation (business_unit_id, status);

CREATE TABLE reservation_room (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  reservation_id    uuid NOT NULL,
  room_type_id      uuid NOT NULL,
  room_id           uuid NOT NULL,
  UNIQUE (reservation_id, room_id),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (reservation_id, business_unit_id) REFERENCES reservation(id, business_unit_id),
  FOREIGN KEY (room_type_id, business_unit_id) REFERENCES room_type(id, business_unit_id),
  FOREIGN KEY (room_id, business_unit_id) REFERENCES room(id, business_unit_id)
);

CREATE TABLE room_night (
  room_id              uuid NOT NULL,
  stay_date            date NOT NULL,
  business_unit_id     uuid NOT NULL,
  reservation_room_id  uuid NOT NULL,
  rate                 numeric(14, 2) NOT NULL,
  charged_entry_id     bigint,           -- folio entry once the night audit has charged it
  PRIMARY KEY (room_id, stay_date),
  FOREIGN KEY (reservation_room_id, business_unit_id) REFERENCES reservation_room(id, business_unit_id) ON DELETE CASCADE
);
CREATE INDEX ON room_night (reservation_room_id);

-- =====================================================================
-- Guest folios: the running bill. Amounts are signed: charges +, payments −, refunds +.
-- Balance due = sum(amount). Entries are permanent; corrections are new entries.
-- =====================================================================
CREATE TYPE folio_status AS ENUM ('open', 'closed');
CREATE TYPE folio_entry_type AS ENUM ('room', 'charge', 'service_charge', 'tax', 'payment', 'refund', 'adjustment', 'other_unit');

CREATE TABLE folio (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  folio_number      text NOT NULL,
  reservation_id    uuid NOT NULL UNIQUE,
  status            folio_status NOT NULL DEFAULT 'open',
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  UNIQUE (business_unit_id, folio_number),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (reservation_id, business_unit_id) REFERENCES reservation(id, business_unit_id)
);

CREATE TABLE folio_entry (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  business_unit_id    uuid NOT NULL,
  folio_id            uuid NOT NULL,
  entry_type          folio_entry_type NOT NULL,
  description         text NOT NULL,
  amount              numeric(16, 2) NOT NULL CHECK (amount <> 0),
  method              payment_method,
  reference           text,
  stay_date           date,
  source_business_unit_id uuid REFERENCES business_unit(id),   -- for charges posted by another unit
  source_doc_type     text,
  source_doc_id       text,
  reverses_entry_id   bigint REFERENCES folio_entry(id),
  journal_entry_id    bigint REFERENCES journal_entry(id),
  posted_by           uuid NOT NULL REFERENCES app_user(id),
  posted_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (folio_id, business_unit_id) REFERENCES folio(id, business_unit_id),
  CHECK ((entry_type IN ('payment', 'refund')) = (method IS NOT NULL))
);
CREATE INDEX ON folio_entry (folio_id, id);

CREATE TRIGGER folio_entry_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON folio_entry
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();
ALTER TABLE room_night ADD FOREIGN KEY (charged_entry_id) REFERENCES folio_entry(id);

CREATE FUNCTION apt.folio_balance(p_folio uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(amount), 0) FROM folio_entry WHERE folio_id = p_folio
$$;

-- Ledger account for a payment method.
CREATE FUNCTION fin.method_account(p_method payment_method) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_method::text WHEN 'cash' THEN '1000' WHEN 'card' THEN '1010' WHEN 'transfer' THEN '1020' END
$$;

-- Posts a charge with service charge and VAT (per the Apartments unit's settings) to a folio,
-- and to the ledger: Dr Guest ledger, Cr revenue / service charge / VAT.
CREATE FUNCTION apt.post_charge(p_folio uuid, p_type folio_entry_type, p_description text, p_net numeric, p_stay_date date,
                                p_revenue_code text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  f       folio%ROWTYPE;
  v_svc   numeric;
  v_tax   numeric;
  v_entry bigint;
  v_first bigint;
BEGIN
  SELECT * INTO f FROM folio WHERE id = p_folio;
  v_svc := round(p_net * pos.setting_pct(f.business_unit_id, 'charges.service_pct', 0) / 100, 2);
  v_tax := round((p_net + v_svc) * pos.setting_pct(f.business_unit_id, 'tax.vat_pct', 0) / 100, 2);
  v_entry := fin.post_entry(f.business_unit_id, current_date, 'folio', p_folio::text, p_description, jsonb_build_array(
    jsonb_build_object('code', '1100', 'debit', p_net + v_svc + v_tax),
    jsonb_build_object('code', p_revenue_code, 'credit', p_net),
    jsonb_build_object('code', '4100', 'credit', v_svc),
    jsonb_build_object('code', '2100', 'credit', v_tax)));
  INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, stay_date, journal_entry_id, posted_by)
  VALUES (f.tenant_id, f.business_unit_id, p_folio, p_type, p_description, p_net, p_stay_date, v_entry, sec.current_user_id())
  RETURNING id INTO v_first;
  IF v_svc <> 0 THEN
    INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, stay_date, journal_entry_id, posted_by)
    VALUES (f.tenant_id, f.business_unit_id, p_folio, 'service_charge', 'Service charge · ' || p_description, v_svc, p_stay_date, v_entry, sec.current_user_id());
  END IF;
  IF v_tax <> 0 THEN
    INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, stay_date, journal_entry_id, posted_by)
    VALUES (f.tenant_id, f.business_unit_id, p_folio, 'tax', 'VAT · ' || p_description, v_tax, p_stay_date, v_entry, sec.current_user_id());
  END IF;
  RETURN v_first;
END $$;

-- Locks every night of a booked room. Rooms are taken in a fixed order, so concurrent bookings
-- cannot deadlock; a clash surfaces as a clear message, not a raw key violation.
CREATE FUNCTION apt.lock_nights(p_rr uuid, p_from date, p_to date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rr reservation_room%ROWTYPE;
  d  date;
BEGIN
  SELECT * INTO rr FROM reservation_room WHERE id = p_rr;
  FOR d IN SELECT generate_series(p_from, p_to - 1, interval '1 day')::date LOOP
    BEGIN
      INSERT INTO room_night (room_id, stay_date, business_unit_id, reservation_room_id, rate)
      VALUES (rr.room_id, d, rr.business_unit_id, p_rr, apt.nightly_rate(rr.room_type_id, d));
    EXCEPTION WHEN unique_violation THEN
      -- GD409: our own "booking clash" code, so the message reaches the user as a 409 conflict.
      RAISE EXCEPTION 'room % is already booked on %', (SELECT room_number FROM room WHERE id = rr.room_id), d
        USING ERRCODE = 'GD409';
    END;
  END LOOP;
END $$;

-- Rooms: [{"roomTypeId": uuid, "roomId": uuid?}] — without a room, the first free room of the type is assigned.
CREATE FUNCTION apt.book(p_bu uuid, p_customer uuid, p_source reservation_source, p_check_in date, p_check_out date,
                         p_adults integer, p_children integer, p_notes text, p_rooms jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_res     uuid;
  v_ref     text;
  v_rr      uuid;
  v_req     jsonb;
  v_type    room_type%ROWTYPE;
  v_room    uuid;
  v_done    boolean;
  r         record;
BEGIN
  IF NOT sec.has_scope(p_bu, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot take bookings in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT unit_type FROM business_unit WHERE id = p_bu) <> 'apartments' THEN
    RAISE EXCEPTION 'rooms are booked in an apartments unit' USING ERRCODE = 'check_violation';
  END IF;
  IF p_check_in IS NULL OR p_check_out IS NULL OR p_check_out <= p_check_in THEN
    RAISE EXCEPTION 'check-out must be after check-in' USING ERRCODE = 'check_violation';
  END IF;
  IF p_check_in < current_date THEN
    RAISE EXCEPTION 'check-in cannot be in the past' USING ERRCODE = 'check_violation';
  END IF;
  IF p_check_out - p_check_in > 90 THEN
    RAISE EXCEPTION 'stays longer than 90 nights need a long-let agreement' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_rooms) <> 'array' OR jsonb_array_length(p_rooms) = 0 THEN
    RAISE EXCEPTION 'book at least one room' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer WHERE id = p_customer AND tenant_id = sec.current_tenant_id()) THEN
    RAISE EXCEPTION 'guest not found' USING ERRCODE = 'check_violation';
  END IF;

  v_ref := inv.next_doc_number(p_bu, 'RES');
  INSERT INTO reservation (tenant_id, business_unit_id, booking_ref, customer_id, source, check_in, check_out,
                           adults, children, notes, created_by)
  VALUES (sec.current_tenant_id(), p_bu, v_ref, p_customer, coalesce(p_source, 'direct'), p_check_in, p_check_out,
          coalesce(p_adults, 1), coalesce(p_children, 0), coalesce(p_notes, ''), sec.current_user_id())
  RETURNING id INTO v_res;

  FOR v_req IN SELECT * FROM jsonb_array_elements(p_rooms) LOOP
    SELECT * INTO v_type FROM room_type WHERE id = (v_req->>'roomTypeId')::uuid AND business_unit_id = p_bu AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'room type not found' USING ERRCODE = 'check_violation'; END IF;
    v_room := nullif(v_req->>'roomId', '')::uuid;

    IF v_room IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM room WHERE id = v_room AND room_type_id = v_type.id AND is_active AND status <> 'out_of_order') THEN
        RAISE EXCEPTION 'that room is not a bookable % room', v_type.name USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO reservation_room (tenant_id, business_unit_id, reservation_id, room_type_id, room_id)
      VALUES (sec.current_tenant_id(), p_bu, v_res, v_type.id, v_room) RETURNING id INTO v_rr;
      PERFORM apt.lock_nights(v_rr, p_check_in, p_check_out);
    ELSE
      -- Try free rooms of the type in order; a room taken concurrently just moves us on to the next.
      v_done := false;
      FOR r IN SELECT rm.id FROM room rm
                WHERE rm.room_type_id = v_type.id AND rm.is_active AND rm.status <> 'out_of_order'
                  AND NOT EXISTS (SELECT 1 FROM room_night n WHERE n.room_id = rm.id AND n.stay_date >= p_check_in AND n.stay_date < p_check_out)
                  AND NOT EXISTS (SELECT 1 FROM reservation_room x WHERE x.reservation_id = v_res AND x.room_id = rm.id)
                ORDER BY rm.room_number LOOP
        BEGIN
          INSERT INTO reservation_room (tenant_id, business_unit_id, reservation_id, room_type_id, room_id)
          VALUES (sec.current_tenant_id(), p_bu, v_res, v_type.id, r.id) RETURNING id INTO v_rr;
          PERFORM apt.lock_nights(v_rr, p_check_in, p_check_out);
          v_done := true;
          EXIT;
        EXCEPTION WHEN SQLSTATE 'GD409' THEN
          NULL;   -- taken by someone else a moment ago; try the next room
        END;
      END LOOP;
      IF NOT v_done THEN
        RAISE EXCEPTION 'no % room is free for those dates', v_type.name USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;

  INSERT INTO folio (tenant_id, business_unit_id, folio_number, reservation_id)
  VALUES (sec.current_tenant_id(), p_bu, inv.next_doc_number(p_bu, 'FOL'), v_res);
  RETURN v_res;
END $$;

-- Night audit: charges every in-house room for each night up to and including p_through that
-- has not been charged yet. Safe to run more than once.
CREATE FUNCTION apt.post_room_charges(p_bu uuid, p_through date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n       record;
  v_entry bigint;
  v_count integer := 0;
BEGIN
  IF NOT sec.has_scope(p_bu, 'FIN', true) THEN
    RAISE EXCEPTION 'you cannot post charges in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR n IN SELECT rn.room_id, rn.stay_date, rn.rate, rm.room_number, f.id AS folio_id
             FROM room_night rn
             JOIN reservation_room rr ON rr.id = rn.reservation_room_id
             JOIN reservation r ON r.id = rr.reservation_id AND r.status = 'checked_in'
             JOIN folio f ON f.reservation_id = r.id
             JOIN room rm ON rm.id = rn.room_id
            WHERE rn.business_unit_id = p_bu AND rn.charged_entry_id IS NULL AND rn.stay_date <= p_through
            ORDER BY rn.room_id, rn.stay_date
              FOR UPDATE OF rn LOOP
    v_entry := apt.post_charge(n.folio_id, 'room', format('Room %s · night of %s', n.room_number, to_char(n.stay_date, 'DD Mon YYYY')),
                               n.rate, n.stay_date, '4200');
    UPDATE room_night SET charged_entry_id = v_entry WHERE room_id = n.room_id AND stay_date = n.stay_date;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

CREATE FUNCTION apt.lock_reservation(p_res uuid) RETURNS reservation
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r reservation%ROWTYPE;
BEGIN
  SELECT * INTO r FROM reservation WHERE id = p_res AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(r.business_unit_id, 'OPS') THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT sec.has_scope(r.business_unit_id, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot change reservations in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION apt.check_in(p_res uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r reservation%ROWTYPE; v_blocked text;
BEGIN
  r := apt.lock_reservation(p_res);
  IF r.status <> 'confirmed' THEN RAISE EXCEPTION 'only a confirmed booking can check in (this one is %)', r.status USING ERRCODE = 'check_violation'; END IF;
  IF r.check_in > current_date THEN RAISE EXCEPTION 'arrival is %; it is too early to check in', r.check_in USING ERRCODE = 'check_violation'; END IF;
  IF r.check_out <= current_date THEN RAISE EXCEPTION 'this booking''s stay has already ended' USING ERRCODE = 'check_violation'; END IF;
  SELECT string_agg(rm.room_number || ' (' || replace(rm.status::text, '_', ' ') || ')', ', ') INTO v_blocked
    FROM reservation_room rr JOIN room rm ON rm.id = rr.room_id
   WHERE rr.reservation_id = p_res AND rm.status <> 'available';
  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'room not ready: %', v_blocked USING ERRCODE = 'check_violation';
  END IF;
  UPDATE room SET status = 'occupied', row_version = row_version + 1
   WHERE id IN (SELECT room_id FROM reservation_room WHERE reservation_id = p_res);
  UPDATE reservation SET status = 'checked_in', checked_in_by = sec.current_user_id(), checked_in_at = now(),
         row_version = row_version + 1 WHERE id = p_res;
END $$;

-- Check-out: charges every night actually stayed (an early departure releases the rest),
-- requires a settled folio, frees the rooms for cleaning and closes the folio.
CREATE FUNCTION apt.check_out(p_res uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r       reservation%ROWTYPE;
  f       folio%ROWTYPE;
  v_last  date;
  v_bal   numeric;
BEGIN
  r := apt.lock_reservation(p_res);
  IF r.status <> 'checked_in' THEN RAISE EXCEPTION 'only an in-house guest can check out' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO f FROM folio WHERE reservation_id = p_res FOR UPDATE;
  v_last := least(r.check_out, greatest(current_date, r.check_in + 1)) - 1;   -- last night stayed
  DELETE FROM room_night WHERE reservation_room_id IN (SELECT id FROM reservation_room WHERE reservation_id = p_res)
     AND stay_date > v_last AND charged_entry_id IS NULL;
  PERFORM apt.post_room_charges(r.business_unit_id, v_last);
  v_bal := apt.folio_balance(f.id);
  IF v_bal <> 0 THEN
    RAISE EXCEPTION 'the bill is not settled: % %', CASE WHEN v_bal > 0 THEN 'balance due' ELSE 'credit to refund' END, abs(v_bal)
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE room SET status = 'cleaning', row_version = row_version + 1
   WHERE id IN (SELECT room_id FROM reservation_room WHERE reservation_id = p_res);
  INSERT INTO housekeeping_task (tenant_id, business_unit_id, room_id, task_type, notes, created_by)
  SELECT r.tenant_id, r.business_unit_id, room_id, 'clean', 'Departure · ' || r.booking_ref, sec.current_user_id()
    FROM reservation_room WHERE reservation_id = p_res;
  UPDATE reservation SET status = 'checked_out', checked_out_by = sec.current_user_id(), checked_out_at = now(),
         check_out = least(r.check_out, v_last + 1), row_version = row_version + 1 WHERE id = p_res;
  UPDATE folio SET status = 'closed', closed_at = now() WHERE id = f.id;
END $$;

CREATE FUNCTION apt.cancel(p_res uuid, p_action text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r reservation%ROWTYPE; f folio%ROWTYPE;
BEGIN
  r := apt.lock_reservation(p_res);
  IF r.status <> 'confirmed' THEN RAISE EXCEPTION 'only a confirmed booking can be %', p_action USING ERRCODE = 'check_violation'; END IF;
  IF p_action = 'no_show' AND r.check_in >= current_date THEN
    RAISE EXCEPTION 'a guest can only be a no-show after their arrival date' USING ERRCODE = 'check_violation';
  END IF;
  IF p_action = 'cancelled' AND coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'give a reason for cancelling' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO f FROM folio WHERE reservation_id = p_res FOR UPDATE;
  IF apt.folio_balance(f.id) <> 0 THEN
    RAISE EXCEPTION 'settle the bill first: refund the deposit or post a cancellation fee' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM room_night WHERE reservation_room_id IN (SELECT id FROM reservation_room WHERE reservation_id = p_res);
  UPDATE reservation SET status = p_action::reservation_status, cancelled_by = sec.current_user_id(), cancelled_at = now(),
         cancel_reason = p_reason, row_version = row_version + 1 WHERE id = p_res;
  UPDATE folio SET status = 'closed', closed_at = now() WHERE id = f.id;
END $$;

-- Extend a stay: every room is locked for the extra nights or the whole change is refused.
CREATE FUNCTION apt.extend(p_res uuid, p_new_check_out date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r reservation%ROWTYPE; rr record;
BEGIN
  r := apt.lock_reservation(p_res);
  IF r.status NOT IN ('confirmed', 'checked_in') THEN RAISE EXCEPTION 'this booking cannot be changed' USING ERRCODE = 'check_violation'; END IF;
  IF p_new_check_out <= r.check_out THEN RAISE EXCEPTION 'the new departure must be later than %', r.check_out USING ERRCODE = 'check_violation'; END IF;
  FOR rr IN SELECT id FROM reservation_room WHERE reservation_id = p_res ORDER BY room_id LOOP
    PERFORM apt.lock_nights(rr.id, r.check_out, p_new_check_out);
  END LOOP;
  UPDATE reservation SET check_out = p_new_check_out, row_version = row_version + 1 WHERE id = p_res;
END $$;

-- Folio actions from the front desk.
--   payment / refund : FIN write          (front desk)
--   charge           : FIN write          (laundry, cancellation fee… net amount; service charge and VAT added)
--   adjustment       : FIN write + CFG write (a manager: discounts, corrections; negative amount)
CREATE FUNCTION apt.folio_post(p_folio uuid, p_kind text, p_description text, p_amount numeric,
                               p_method payment_method, p_reference text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  f       folio%ROWTYPE;
  v_entry bigint;
  v_je    bigint;
BEGIN
  SELECT * INTO f FROM folio WHERE id = p_folio AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(f.business_unit_id, 'FIN') THEN RAISE EXCEPTION 'folio not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT sec.has_scope(f.business_unit_id, 'FIN', true) THEN
    RAISE EXCEPTION 'you cannot post to guest bills' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF f.status <> 'open' THEN RAISE EXCEPTION 'this bill is closed' USING ERRCODE = 'check_violation'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'enter an amount above zero' USING ERRCODE = 'check_violation'; END IF;
  p_amount := round(p_amount, 2);

  IF p_kind = 'payment' THEN
    IF p_method IS NULL OR p_method::text = 'room' THEN RAISE EXCEPTION 'choose cash, card or transfer' USING ERRCODE = 'check_violation'; END IF;
    v_je := fin.post_entry(f.business_unit_id, current_date, 'folio', p_folio::text, 'Payment · ' || f.folio_number,
      jsonb_build_array(jsonb_build_object('code', fin.method_account(p_method), 'debit', p_amount),
                        jsonb_build_object('code', '1100', 'credit', p_amount)));
    INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, method, reference, journal_entry_id, posted_by)
    VALUES (f.tenant_id, f.business_unit_id, p_folio, 'payment', coalesce(nullif(trim(p_description), ''), 'Payment'),
            -p_amount, p_method, nullif(trim(p_reference), ''), v_je, sec.current_user_id())
    RETURNING id INTO v_entry;
  ELSIF p_kind = 'refund' THEN
    IF p_method IS NULL OR p_method::text = 'room' THEN RAISE EXCEPTION 'choose cash, card or transfer' USING ERRCODE = 'check_violation'; END IF;
    IF p_amount > -apt.folio_balance(p_folio) THEN
      RAISE EXCEPTION 'you can only refund a credit balance (currently %)', greatest(-apt.folio_balance(p_folio), 0) USING ERRCODE = 'check_violation';
    END IF;
    v_je := fin.post_entry(f.business_unit_id, current_date, 'folio', p_folio::text, 'Refund · ' || f.folio_number,
      jsonb_build_array(jsonb_build_object('code', '1100', 'debit', p_amount),
                        jsonb_build_object('code', fin.method_account(p_method), 'credit', p_amount)));
    INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, method, reference, journal_entry_id, posted_by)
    VALUES (f.tenant_id, f.business_unit_id, p_folio, 'refund', coalesce(nullif(trim(p_description), ''), 'Refund'),
            p_amount, p_method, nullif(trim(p_reference), ''), v_je, sec.current_user_id())
    RETURNING id INTO v_entry;
  ELSIF p_kind = 'charge' THEN
    IF coalesce(trim(p_description), '') = '' THEN RAISE EXCEPTION 'describe the charge' USING ERRCODE = 'check_violation'; END IF;
    v_entry := apt.post_charge(p_folio, 'charge', p_description, p_amount, NULL, '4000');
  ELSIF p_kind = 'adjustment' THEN
    IF NOT sec.has_scope(f.business_unit_id, 'CFG', true) THEN
      RAISE EXCEPTION 'adjustments need a manager' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF coalesce(trim(p_description), '') = '' THEN RAISE EXCEPTION 'give a reason for the adjustment' USING ERRCODE = 'check_violation'; END IF;
    IF p_amount > apt.folio_balance(p_folio) THEN
      RAISE EXCEPTION 'an adjustment cannot exceed the balance due' USING ERRCODE = 'check_violation';
    END IF;
    v_je := fin.post_entry(f.business_unit_id, current_date, 'folio', p_folio::text, 'Adjustment · ' || p_description,
      jsonb_build_array(jsonb_build_object('code', '4200', 'debit', p_amount),
                        jsonb_build_object('code', '1100', 'credit', p_amount)));
    INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, journal_entry_id, posted_by)
    VALUES (f.tenant_id, f.business_unit_id, p_folio, 'adjustment', p_description, -p_amount, v_je, sec.current_user_id())
    RETURNING id INTO v_entry;
  ELSE
    RAISE EXCEPTION 'unknown folio action %', p_kind;
  END IF;
  RETURN v_entry;
END $$;

-- =====================================================================
-- Charge to room from another unit's till (F&B, Spa…). The selling unit's books show
-- "due from Apartments"; the Apartments books show the guest owing it and Apartments
-- owing the selling unit. The seller never sees the guest's bill.
-- =====================================================================
CREATE FUNCTION apt.in_house() RETURNS TABLE (reservation_id uuid, business_unit_id uuid, unit_name text, room_numbers text, guest_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.business_unit_id, bu.name,
         (SELECT string_agg(rm.room_number, ', ' ORDER BY rm.room_number) FROM reservation_room rr JOIN room rm ON rm.id = rr.room_id
           WHERE rr.reservation_id = r.id),
         c.full_name
    FROM reservation r JOIN customer c ON c.id = r.customer_id JOIN business_unit bu ON bu.id = r.business_unit_id
   WHERE r.tenant_id = sec.current_tenant_id() AND r.status = 'checked_in'
     AND EXISTS (SELECT 1 FROM user_access_scope s WHERE s.user_id = sec.current_user_id()
                   AND s.data_class = 'FIN' AND s.access_level = 'write')
   ORDER BY 4
$$;

CREATE FUNCTION apt.charge_to_room(p_seller_bu uuid, p_reservation uuid, p_amount numeric, p_description text,
                                   p_source_type text, p_source_id text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r       reservation%ROWTYPE;
  f       folio%ROWTYPE;
  v_je    bigint;
  v_entry bigint;
BEGIN
  SELECT * INTO r FROM reservation WHERE id = p_reservation AND tenant_id = sec.current_tenant_id();
  IF NOT FOUND OR r.status <> 'checked_in' THEN
    RAISE EXCEPTION 'that guest is not checked in; take another payment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO f FROM folio WHERE reservation_id = p_reservation FOR UPDATE;
  IF f.status <> 'open' THEN RAISE EXCEPTION 'that guest''s bill is closed' USING ERRCODE = 'check_violation'; END IF;
  IF r.business_unit_id <> p_seller_bu THEN
    v_je := fin.post_entry(r.business_unit_id, current_date, 'folio', f.id::text, p_description, jsonb_build_array(
      jsonb_build_object('code', '1100', 'debit', p_amount),
      jsonb_build_object('code', '2200', 'credit', p_amount, 'counterparty', p_seller_bu)));
  END IF;
  INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, source_business_unit_id,
                           source_doc_type, source_doc_id, journal_entry_id, posted_by)
  VALUES (r.tenant_id, r.business_unit_id, f.id, 'other_unit', p_description, p_amount, p_seller_bu, p_source_type, p_source_id,
          v_je, sec.current_user_id())
  RETURNING id INTO v_entry;
  RETURN v_entry;
END $$;

-- Reverses the room charges of a voided ticket (the guest's bill must still be open).
CREATE FUNCTION apt.reverse_room_charges(p_ticket uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e folio_entry%ROWTYPE; f folio%ROWTYPE; v_je bigint;
BEGIN
  FOR e IN SELECT * FROM folio_entry WHERE source_doc_type = 'sale_ticket' AND source_doc_id = p_ticket::text
             AND reverses_entry_id IS NULL ORDER BY id LOOP
    SELECT * INTO f FROM folio WHERE id = e.folio_id FOR UPDATE;
    IF f.status <> 'open' THEN
      RAISE EXCEPTION 'the guest has checked out; this room charge must be settled with the Apartments front desk'
        USING ERRCODE = 'check_violation';
    END IF;
    v_je := NULL;
    IF e.journal_entry_id IS NOT NULL THEN
      v_je := fin.reverse_entry(e.journal_entry_id, 'folio', f.id::text, 'Voided: ' || e.description);
    END IF;
    INSERT INTO folio_entry (tenant_id, business_unit_id, folio_id, entry_type, description, amount, source_business_unit_id,
                             source_doc_type, source_doc_id, reverses_entry_id, journal_entry_id, posted_by)
    VALUES (e.tenant_id, e.business_unit_id, e.folio_id, 'other_unit', 'Voided: ' || e.description, -e.amount,
            e.source_business_unit_id, 'sale_ticket_void', p_ticket::text, e.id, v_je, sec.current_user_id());
  END LOOP;
END $$;

ALTER TABLE sale_payment ADD COLUMN reservation_id uuid REFERENCES reservation(id);
ALTER TABLE sale_payment ADD CHECK ((method::text = 'room') = (reservation_id IS NOT NULL));

-- The seller's journal lines for room payments on a ticket: Dr Guest ledger when the till belongs
-- to the Apartments unit itself, otherwise Dr Due from Apartments.
CREATE FUNCTION pos.room_payment_lines(p_ticket uuid, p_bu uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', CASE WHEN r.business_unit_id = p_bu THEN '1100' ELSE '1150' END,
           'debit', sp.amount,
           'counterparty', CASE WHEN r.business_unit_id = p_bu THEN NULL ELSE r.business_unit_id END)), '[]'::jsonb)
    FROM sale_payment sp JOIN reservation r ON r.id = sp.reservation_id
   WHERE sp.sale_ticket_id = p_ticket AND sp.method::text = 'room'
$$;


CREATE OR REPLACE FUNCTION pos.checkout(p_bu uuid, p_department uuid, p_location uuid, p_customer uuid, p_discount_pct numeric,
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

    SELECT s.movement_ids, s.cost INTO v_moves, v_cost
      FROM pos.stock_for_sale(p_bu, v_item.id, v_qty, p_location, v_number, v_ticket) s;
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
    INSERT INTO sale_payment (tenant_id, business_unit_id, sale_ticket_id, method, amount, reference, reservation_id)
    VALUES (v_tenant, p_bu, v_ticket, (v_pay->>'method')::payment_method, round((v_pay->>'amount')::numeric, 2),
            nullif(trim(v_pay->>'reference'), ''), nullif(v_pay->>'reservationId', '')::uuid);
    IF v_pay->>'method' = 'room' THEN
      PERFORM apt.charge_to_room(p_bu, (v_pay->>'reservationId')::uuid, round((v_pay->>'amount')::numeric, 2),
        (SELECT name FROM business_unit WHERE id = p_bu) || ' · ' || v_number, 'sale_ticket', v_ticket::text);
    END IF;
    v_paid := v_paid + round((v_pay->>'amount')::numeric, 2);
    IF v_pay->>'method' = 'cash' THEN v_cash := v_cash + round((v_pay->>'amount')::numeric, 2);
    ELSE v_noncash := v_noncash + round((v_pay->>'amount')::numeric, 2); END IF;
  END LOOP;
  IF v_paid < v_total THEN
    RAISE EXCEPTION 'payment of % is short of the total %', v_paid, v_total USING ERRCODE = 'check_violation';
  END IF;
  IF v_noncash > v_total THEN
    RAISE EXCEPTION 'card, transfer and room payments cannot exceed the total (change is only given from cash)' USING ERRCODE = 'check_violation';
  END IF;
  v_change := v_paid - v_total;


  -- Money in by method (cash net of change), revenue net of discount, service charge, VAT.
  v_entry := fin.post_entry(p_bu, current_date, 'sale_ticket', v_ticket::text, v_number, jsonb_build_array(
    jsonb_build_object('code', '1000', 'debit', v_cash - v_change),
    jsonb_build_object('code', '1010', 'debit', (SELECT coalesce(sum(amount), 0) FROM sale_payment WHERE sale_ticket_id = v_ticket AND method = 'card')),
    jsonb_build_object('code', '1020', 'debit', (SELECT coalesce(sum(amount), 0) FROM sale_payment WHERE sale_ticket_id = v_ticket AND method = 'transfer')),
    jsonb_build_object('code', '4000', 'credit', v_net),
    jsonb_build_object('code', '4100', 'credit', v_svc),
    jsonb_build_object('code', '2100', 'credit', v_tax)) || pos.room_payment_lines(v_ticket, p_bu));
  UPDATE sale_ticket SET subtotal = v_subtotal, discount_amount = v_discount, service_charge_amount = v_svc,
         tax_amount = v_tax, total = v_total, amount_paid = v_paid, change_due = v_change,
         journal_entry_id = v_entry, is_final = true
   WHERE id = v_ticket;
  RETURN v_ticket;
END $$;

CREATE OR REPLACE FUNCTION pos.void_ticket(p_ticket uuid, p_reason text) RETURNS void
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
  PERFORM apt.reverse_room_charges(p_ticket);   -- take any charge-to-room back off the guest's bill
  IF t.journal_entry_id IS NOT NULL THEN
    v_rev := fin.reverse_entry(t.journal_entry_id, 'sale_void', p_ticket::text, 'void ' || t.ticket_number || ': ' || p_reason);
  END IF;
  UPDATE sale_ticket SET status = 'voided', voided_by = sec.current_user_id(), voided_at = now(),
         void_reason = p_reason, void_journal_entry_id = v_rev WHERE id = p_ticket;
END $$;

-- =====================================================================
-- Housekeeping
-- =====================================================================
CREATE TYPE hk_task_type AS ENUM ('clean', 'inspect', 'maintenance');
CREATE TYPE hk_task_status AS ENUM ('open', 'in_progress', 'done');

CREATE TABLE housekeeping_task (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  room_id           uuid NOT NULL,
  task_type         hk_task_type NOT NULL DEFAULT 'clean',
  status            hk_task_status NOT NULL DEFAULT 'open',
  assigned_to       uuid REFERENCES app_user(id),
  notes             text NOT NULL DEFAULT '',
  created_by        uuid REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  done_by           uuid REFERENCES app_user(id),
  done_at           timestamptz,
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (room_id, business_unit_id) REFERENCES room(id, business_unit_id)
);
CREATE INDEX ON housekeeping_task (business_unit_id, status);

-- Housekeepers (assigned staff) and front desk move tasks along. Finishing the last open
-- cleaning task of a room makes it available again.
CREATE FUNCTION apt.task_update(p_task uuid, p_status hk_task_status, p_assign uuid, p_notes text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t housekeeping_task%ROWTYPE;
BEGIN
  SELECT * INTO t FROM housekeeping_task WHERE id = p_task AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(t.business_unit_id, 'OPS') THEN RAISE EXCEPTION 'task not found' USING ERRCODE = 'no_data_found'; END IF;
  -- coalesce: an unassigned task (assigned_to NULL) must not slip through as NULL.
  IF NOT (sec.has_scope(t.business_unit_id, 'OPS', true) OR coalesce(t.assigned_to = sec.current_user_id(), false)) THEN
    RAISE EXCEPTION 'only the assigned housekeeper or the front desk can update this task' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_assign IS DISTINCT FROM t.assigned_to AND NOT sec.has_scope(t.business_unit_id, 'OPS', true) THEN
    RAISE EXCEPTION 'only the front desk assigns tasks' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE housekeeping_task SET status = coalesce(p_status, status), assigned_to = p_assign,
         notes = coalesce(p_notes, notes),
         done_by = CASE WHEN p_status = 'done' THEN sec.current_user_id() ELSE done_by END,
         done_at = CASE WHEN p_status = 'done' THEN now() ELSE done_at END
   WHERE id = p_task;
  IF p_status = 'done' AND t.task_type IN ('clean', 'inspect')
     AND NOT EXISTS (SELECT 1 FROM housekeeping_task WHERE room_id = t.room_id AND status <> 'done' AND id <> p_task) THEN
    UPDATE room SET status = 'available', row_version = row_version + 1 WHERE id = t.room_id AND status = 'cleaning';
  END IF;
END $$;

-- Front desk sets cleaning / maintenance / out of order. An occupied room's status follows the stay.
CREATE FUNCTION apt.set_room_status(p_room uuid, p_status room_status, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rm room%ROWTYPE;
BEGIN
  SELECT * INTO rm FROM room WHERE id = p_room AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(rm.business_unit_id, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot change this room' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF rm.status = 'occupied' OR p_status = 'occupied' THEN
    RAISE EXCEPTION 'occupied is set by check-in and check-out' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE room SET status = p_status, status_note = p_note, row_version = row_version + 1 WHERE id = p_room;
  IF p_status IN ('maintenance', 'cleaning') THEN
    INSERT INTO housekeeping_task (tenant_id, business_unit_id, room_id, task_type, notes, created_by)
    VALUES (rm.tenant_id, rm.business_unit_id, p_room, CASE WHEN p_status = 'maintenance' THEN 'maintenance' ELSE 'clean' END::hk_task_type,
            coalesce(p_note, ''), sec.current_user_id());
  END IF;
END $$;

-- =====================================================================
-- Audit, row-level security, grants
-- =====================================================================
CREATE TRIGGER room_type_version BEFORE UPDATE ON room_type FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON room_type      FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON room           FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON rate_plan      FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON reservation             FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON folio                   FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON folio_entry                       FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON housekeeping_task       FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

ALTER TABLE room_type         ENABLE ROW LEVEL SECURITY;
ALTER TABLE room              ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_plan         ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation_room  ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_night        ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio             ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio_entry       ENABLE ROW LEVEL SECURITY;
ALTER TABLE housekeeping_task ENABLE ROW LEVEL SECURITY;

-- Rooms and rates: anyone working in the unit reads them; managers (CFG write) maintain them.
CREATE POLICY room_type_read ON room_type FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY room_type_write ON room_type FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));
CREATE POLICY room_read ON room FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY room_write ON room FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));
CREATE POLICY rate_plan_read ON rate_plan FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY rate_plan_write ON rate_plan FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));

CREATE POLICY reservation_read ON reservation FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY reservation_room_read ON reservation_room FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY room_night_read ON room_night FOR SELECT TO giddy_app
  USING (sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY folio_read ON folio FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY folio_entry_read ON folio_entry FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY hk_read ON housekeeping_task FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));

GRANT SELECT ON reservation, reservation_room, room_night, folio, folio_entry, housekeeping_task TO giddy_app;
GRANT SELECT, INSERT, DELETE ON rate_plan TO giddy_app;
GRANT SELECT, INSERT ON room_type, room TO giddy_app;
GRANT UPDATE (name, description, max_adults, max_children, base_rate, amenities, is_active) ON room_type TO giddy_app;
GRANT UPDATE (room_type_id, room_number, floor, is_active) ON room TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA apt FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pos FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fin FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  apt.nightly_rate(uuid, date), apt.folio_balance(uuid),
  apt.book(uuid, uuid, reservation_source, date, date, integer, integer, text, jsonb),
  apt.post_room_charges(uuid, date), apt.check_in(uuid), apt.check_out(uuid), apt.cancel(uuid, text, text),
  apt.extend(uuid, date), apt.folio_post(uuid, text, text, numeric, payment_method, text),
  apt.in_house(), apt.task_update(uuid, hk_task_status, uuid, text), apt.set_room_status(uuid, room_status, text)
TO giddy_app;
