-- =====================================================================
-- Stage 15: hardening before go-live (fixes from the security review).
--   * Online bookings keep the guest's details as submitted and never reveal a stored customer.
--   * Limits on unpaid online bookings, stay length and lead time; shorter holds.
--   * Every payment attempt is recorded, so a payment on an older attempt is never lost.
--   * Sign-in throttling per email and address instead of a lock anyone could trigger.
--   * Tenant checks inside helper functions the API role can call.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Online bookings: the guest's details as they gave them, and where the request came from.
-- ---------------------------------------------------------------------
ALTER TABLE online_booking
  ADD COLUMN guest_name   text,
  ADD COLUMN guest_email  citext,
  ADD COLUMN guest_phone  text,
  ADD COLUMN guest_digits text,
  ADD COLUMN client_ip    inet,
  -- The guest's details matched a customer only in part (phone or email): staff should check them.
  ADD COLUMN details_differ boolean NOT NULL DEFAULT false;
UPDATE online_booking o
   SET guest_name = c.full_name, guest_email = c.email, guest_phone = c.phone, guest_digits = c.phone_normalized
  FROM customer c WHERE c.id = o.customer_id;
CREATE INDEX online_booking_open ON online_booking (business_unit_id, payment_status);

-- Every payment started for a booking. Paying any of them settles the booking.
CREATE TABLE online_payment_attempt (
  reference         text PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  online_booking_id uuid NOT NULL REFERENCES online_booking(id),
  gateway           text NOT NULL,
  payment_url       text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX online_payment_attempt_booking ON online_payment_attempt (online_booking_id, created_at DESC);
ALTER TABLE online_payment_attempt ENABLE ROW LEVEL SECURITY;
CREATE POLICY online_payment_attempt_read ON online_payment_attempt FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND EXISTS (SELECT 1 FROM online_booking o WHERE o.id = online_booking_id));
CREATE POLICY online_payment_attempt_write ON online_payment_attempt FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.current_user_id() = web.agent(tenant_id))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.current_user_id() = web.agent(tenant_id));
GRANT SELECT, INSERT ON online_payment_attempt TO giddy_app;
GRANT UPDATE (payment_url) ON online_payment_attempt TO giddy_app;
INSERT INTO online_payment_attempt (reference, tenant_id, online_booking_id, gateway, created_at)
SELECT payment_reference, tenant_id, id, coalesce(gateway, 'test'), created_at FROM online_booking WHERE payment_reference IS NOT NULL;

-- A booking by its secret link, or by any payment reference ever started for it.
CREATE OR REPLACE FUNCTION web.resolve_booking(p_token_hash bytea, p_reference text, OUT tenant_id uuid, OUT agent_id uuid, OUT booking_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.tenant_id, web.agent(o.tenant_id), o.id FROM online_booking o
   WHERE (p_token_hash IS NOT NULL AND o.manage_token_hash = p_token_hash)
      OR (p_reference IS NOT NULL AND (o.payment_reference = p_reference
          OR o.id = (SELECT pa.online_booking_id FROM online_payment_attempt pa WHERE pa.reference = p_reference)))
   LIMIT 1
$$;

-- Only the hold sweeper (which runs with no signed-in user) may list tenants.
CREATE OR REPLACE FUNCTION web.tenants_with_holds() RETURNS TABLE (tenant_id uuid, agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT o.tenant_id, web.agent(o.tenant_id) FROM online_booking o
   WHERE o.payment_status = 'pending' AND sec.current_user_id() IS NULL
$$;

-- ---------------------------------------------------------------------
-- Limits on online booking (editable per unit like the other online.* settings).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION web.provision_unit(p_bu uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bu business_unit%ROWTYPE; v_agent uuid;
BEGIN
  SELECT * INTO bu FROM business_unit WHERE id = p_bu;
  IF bu.unit_type NOT IN ('apartments', 'spa', 'content_studio') THEN RETURN; END IF;
  v_agent := web.agent(bu.tenant_id);
  IF v_agent IS NULL THEN RETURN; END IF;
  INSERT INTO business_unit_setting (tenant_id, business_unit_id, key, value)
  SELECT bu.tenant_id, bu.id, k, v
    FROM (VALUES ('online.enabled', 'false'::jsonb), ('online.hold_minutes', '15'), ('online.cancel_hours', '24'),
                 ('online.deposit_pct', CASE WHEN bu.unit_type = 'apartments' THEN '100'::jsonb ELSE '0' END),
                 ('online.max_nights', '30'), ('online.max_days_ahead', '365'),
                 ('online.max_open_per_guest', '2'), ('online.max_unpaid_holds', '20')) s(k, v)
   WHERE (bu.unit_type = 'apartments' OR k NOT IN ('online.deposit_pct', 'online.max_nights'))
  ON CONFLICT (business_unit_id, key) DO NOTHING;
  INSERT INTO user_role_assignment (tenant_id, user_id, role_id, business_unit_id, requested_by)
  SELECT bu.tenant_id, v_agent, r.id, bu.id, NULL FROM role r
   WHERE r.code = 'ONLINE_BOOKING' AND r.tenant_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM user_role_assignment a WHERE a.user_id = v_agent AND a.role_id = r.id
                       AND a.business_unit_id = bu.id AND a.status = 'active');
END $$;

UPDATE business_unit_setting SET value = '15' WHERE key = 'online.hold_minutes' AND value = '30'::jsonb;
DO $$ DECLARE bu uuid; BEGIN
  FOR bu IN SELECT id FROM business_unit LOOP PERFORM web.provision_unit(bu); END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Sign-in throttling. Failures are counted per email and network address, so a stranger
-- guessing at someone's account slows only themselves; the response is the same whether or
-- not the email belongs to an account.
-- ---------------------------------------------------------------------
CREATE TABLE sec.login_failure (
  id        bigserial PRIMARY KEY,
  email     citext NOT NULL,
  ip        inet,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_failure_email ON sec.login_failure (email, failed_at);
REVOKE ALL ON sec.login_failure FROM PUBLIC;

-- True when sign-in for this email should be refused for now: 5 failures from this address in
-- 15 minutes, or 50 from anywhere (a spread-out guessing attack).
CREATE FUNCTION sec.auth_throttled(p_email text, p_ip inet) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*) FILTER (WHERE ip IS NOT DISTINCT FROM p_ip) >= 5 OR count(*) >= 50
    FROM sec.login_failure WHERE email = p_email::citext AND failed_at > now() - interval '15 minutes'
$$;

CREATE FUNCTION sec.auth_record_failure(p_email text, p_ip inet, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_count integer;
BEGIN
  INSERT INTO sec.login_failure (email, ip) VALUES (p_email::citext, p_ip);
  DELETE FROM sec.login_failure WHERE failed_at < now() - interval '1 day';
  IF p_user IS NOT NULL THEN
    UPDATE app_user SET failed_login_count = failed_login_count + 1 WHERE id = p_user
    RETURNING tenant_id, failed_login_count INTO v_tenant, v_count;
    PERFORM sec.audit_append(v_tenant, NULL, CASE WHEN sec.auth_throttled(p_email, p_ip) THEN 'login_locked' ELSE 'login_failed' END,
                             'app_user', p_user::text, NULL, jsonb_build_object('failed_count', v_count, 'ip', host(p_ip)));
  END IF;
END $$;

-- A successful sign-in clears the failures from that address.
CREATE FUNCTION sec.auth_clear_failures(p_email text, p_ip inet) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM sec.login_failure WHERE email = p_email::citext AND ip IS NOT DISTINCT FROM p_ip
$$;

GRANT USAGE ON SCHEMA sec TO giddy_app;
GRANT EXECUTE ON FUNCTION sec.auth_throttled(text, inet), sec.auth_record_failure(text, inet, uuid),
  sec.auth_clear_failures(text, inet) TO giddy_app;

-- The old account-wide lock is no longer used; release any that are in place.
UPDATE app_user SET lockout_until = NULL WHERE lockout_until IS NOT NULL;

-- ---------------------------------------------------------------------
-- Helper functions the API role can call: answer only for the caller's own tenant.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apt.folio_balance(p_folio uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(amount), 0) FROM folio_entry WHERE folio_id = p_folio AND tenant_id = sec.current_tenant_id()
$$;

CREATE OR REPLACE FUNCTION apt.nightly_rate(p_room_type uuid, p_night date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT nightly_rate FROM rate_plan WHERE room_type_id = p_room_type AND p_night BETWEEN date_from AND date_to
        AND tenant_id = sec.current_tenant_id()
      ORDER BY priority DESC, date_from DESC LIMIT 1),
    (SELECT base_rate FROM room_type WHERE id = p_room_type AND tenant_id = sec.current_tenant_id()))
$$;

CREATE OR REPLACE FUNCTION bk.bill_balance(p_bill uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(amount), 0) FROM bill_entry WHERE bill_id = p_bill AND tenant_id = sec.current_tenant_id()
$$;

CREATE OR REPLACE FUNCTION bk.bill_paid(p_bill uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(-sum(amount), 0) FROM bill_entry
   WHERE bill_id = p_bill AND entry_type IN ('payment', 'refund') AND tenant_id = sec.current_tenant_id()
$$;

CREATE OR REPLACE FUNCTION bk.expected_total(p_appt uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN a.status = 'completed' THEN 0 ELSE bk.gross(a.business_unit_id, a.price) END
       + coalesce((SELECT sum(e.amount) FROM bill_entry e
                    WHERE e.bill_id = b.id AND e.entry_type NOT IN ('payment', 'refund')), 0)
    FROM appointment a JOIN appointment_bill b ON b.appointment_id = a.id
   WHERE a.id = p_appt AND a.tenant_id = sec.current_tenant_id()
$$;

CREATE OR REPLACE FUNCTION bk.setting_int(p_bu uuid, p_key text, p_default integer) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT (value #>> '{}')::integer FROM business_unit_setting
                    WHERE business_unit_id = p_bu AND key = p_key AND tenant_id = sec.current_tenant_id()), p_default)
$$;

CREATE OR REPLACE FUNCTION pt.terms_on(p_bu uuid, p_date date) RETURNS partnership_agreement
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM partnership_agreement
   WHERE business_unit_id = p_bu AND status = 'agreed' AND effective_from <= p_date AND tenant_id = sec.current_tenant_id()
   ORDER BY effective_from DESC, version DESC LIMIT 1
$$;
