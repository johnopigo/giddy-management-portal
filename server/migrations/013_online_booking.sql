-- =====================================================================
-- 013 Online booking portals (rooms, Spa and Studio) with Paystack deposits.
--
-- Guests book through public pages. Their requests run as the tenant's system
-- account "Online booking": a user that cannot sign in, holding the ONLINE_BOOKING
-- role in each bookable unit, so every rule the booking engines enforce for staff
-- (availability, no double booking, deposits, the books) applies unchanged.
-- A unit takes online bookings only when its manager turns online.enabled on.
--
-- A booking that needs a deposit is held for online.hold_minutes; if the payment is
-- not confirmed by then the hold is released (the booking is cancelled).
-- =====================================================================

CREATE SCHEMA web;
REVOKE ALL ON SCHEMA web FROM PUBLIC;
GRANT USAGE ON SCHEMA web TO giddy_app;

-- ---------------------------------------------------------------------
-- The system account and its role
-- ---------------------------------------------------------------------
ALTER TABLE app_user ADD COLUMN is_system boolean NOT NULL DEFAULT false;
ALTER TABLE tenant ADD COLUMN public_slug text UNIQUE CHECK (public_slug ~ '^[a-z0-9][a-z0-9-]{2,39}$');

-- System accounts are created by the platform only, are never listed, never sign in and never change.
CREATE FUNCTION sec.system_user_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_system AND session_user = 'giddy_app' THEN
    RAISE EXCEPTION 'system accounts are created by the platform' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.is_system OR NEW.is_system) AND session_user = 'giddy_app' THEN
    RAISE EXCEPTION 'system accounts cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER system_user_guard BEFORE INSERT OR UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION sec.system_user_guard();

DROP POLICY app_user_read ON app_user;
CREATE POLICY app_user_read ON app_user FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND NOT is_system AND sec.can_see_user(id));

CREATE OR REPLACE FUNCTION sec.auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, is_active boolean, lockout_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.is_active AND t.status = 'active', u.lockout_until
  FROM app_user u JOIN tenant t ON t.id = u.tenant_id
  WHERE u.email = p_email::citext AND NOT u.is_system
$$;

INSERT INTO role (tenant_id, code, name, description, scope_level, partnership_visibility, is_restricted, partnership_only)
VALUES (NULL, 'ONLINE_BOOKING', 'Online booking (system)',
        'Used only by the public booking pages: takes bookings and online payments in units that allow it.',
        'business_unit', 'none', true, false);
INSERT INTO role_permission (role_id, permission_code)
SELECT r.id, p FROM role r, unnest(ARRAY['ops.read', 'ops.write', 'fin.read', 'fin.write', 'cfg.read']) p
 WHERE r.code = 'ONLINE_BOOKING' AND r.tenant_id IS NULL;

-- The ONLINE_BOOKING role belongs to system accounts only, and system accounts hold nothing else.
CREATE FUNCTION sec.system_role_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_system boolean; v_code text;
BEGIN
  SELECT is_system INTO v_system FROM app_user WHERE id = NEW.user_id;
  SELECT code INTO v_code FROM role WHERE id = NEW.role_id;
  IF (v_code = 'ONLINE_BOOKING') IS DISTINCT FROM coalesce(v_system, false) THEN
    RAISE EXCEPTION 'the online booking role is for the system account only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_system_role_guard BEFORE INSERT ON user_role_assignment FOR EACH ROW EXECUTE FUNCTION sec.system_role_guard();

-- Assignments for system accounts are made by the platform (also when a unit is created through the API).
CREATE OR REPLACE FUNCTION sec.assignment_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role  role%ROWTYPE;
  v_model management_model;
  v_needs_partner_approval boolean;
BEGIN
  SELECT * INTO v_role FROM role WHERE id = NEW.role_id;
  IF v_role.tenant_id IS NOT NULL AND v_role.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'role belongs to another tenant' USING ERRCODE = 'check_violation';
  END IF;
  IF (v_role.scope_level = 'tenant' AND (NEW.business_unit_id IS NOT NULL OR NEW.branch_id IS NOT NULL OR NEW.department_id IS NOT NULL))
     OR (v_role.scope_level IN ('business_unit', 'self') AND (NEW.business_unit_id IS NULL OR NEW.branch_id IS NOT NULL OR NEW.department_id IS NOT NULL))
     OR (v_role.scope_level = 'branch' AND (NEW.business_unit_id IS NULL OR NEW.branch_id IS NULL OR NEW.department_id IS NOT NULL))
     OR (v_role.scope_level = 'department' AND (NEW.business_unit_id IS NULL OR NEW.department_id IS NULL)) THEN
    RAISE EXCEPTION 'scope does not match role scope level %', v_role.scope_level USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.business_unit_id IS NOT NULL THEN
    SELECT management_model INTO v_model FROM business_unit WHERE id = NEW.business_unit_id;
  END IF;
  IF v_role.partnership_only AND v_model IS DISTINCT FROM 'partnership' THEN
    RAISE EXCEPTION 'role % may only be assigned in a partnership-managed unit', v_role.code USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.requested_by IS NULL THEN
    IF session_user = 'giddy_app' AND NOT coalesce((SELECT is_system FROM app_user WHERE id = NEW.user_id), false) THEN
      RAISE EXCEPTION 'requested_by is required' USING ERRCODE = 'check_violation';
    END IF;
    NEW.status := 'active';
    RETURN NEW;
  END IF;

  IF NEW.requested_by IS DISTINCT FROM sec.current_user_id() THEN
    RAISE EXCEPTION 'requested_by must be the current user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_role.is_restricted THEN
    IF NOT sec.has_perm('roles.assign_restricted') THEN
      RAISE EXCEPTION 'role % can only be assigned by the system owner', v_role.code USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT sec.has_perm('roles.assign') THEN
    RAISE EXCEPTION 'missing permission roles.assign' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT EXISTS (SELECT 1 FROM role_permission rp JOIN permission p ON p.code = rp.permission_code
                 WHERE rp.role_id = NEW.role_id AND p.data_class IN ('FIN', 'CFG'))
    INTO v_needs_partner_approval;
  v_needs_partner_approval := v_needs_partner_approval AND v_model = 'partnership' AND NOT v_role.is_restricted;
  NEW.status       := CASE WHEN v_needs_partner_approval THEN 'pending_approval' ELSE 'active' END;
  NEW.requested_at := now();
  NEW.decided_by   := NULL;
  NEW.decided_at   := NULL;
  NEW.revoked_by   := NULL;
  NEW.revoked_at   := NULL;
  RETURN NEW;
END $$;

CREATE FUNCTION web.agent(p_tenant uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM app_user WHERE tenant_id = p_tenant AND is_system AND full_name = 'Online booking'
$$;

CREATE FUNCTION web.require_agent() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF sec.current_user_id() IS NULL OR sec.current_user_id() IS DISTINCT FROM web.agent(sec.current_tenant_id()) THEN
    RAISE EXCEPTION 'only the online booking account can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Gives a bookable unit its online settings (off by default) and the system account's role there.
CREATE FUNCTION web.provision_unit(p_bu uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE bu business_unit%ROWTYPE; v_agent uuid;
BEGIN
  SELECT * INTO bu FROM business_unit WHERE id = p_bu;
  IF bu.unit_type NOT IN ('apartments', 'spa', 'content_studio') THEN RETURN; END IF;
  v_agent := web.agent(bu.tenant_id);
  IF v_agent IS NULL THEN RETURN; END IF;
  INSERT INTO business_unit_setting (tenant_id, business_unit_id, key, value)
  SELECT bu.tenant_id, bu.id, k, v
    FROM (VALUES ('online.enabled', 'false'::jsonb), ('online.hold_minutes', '30'), ('online.cancel_hours', '24'),
                 ('online.deposit_pct', CASE WHEN bu.unit_type = 'apartments' THEN '100'::jsonb ELSE '0' END)) s(k, v)
   WHERE bu.unit_type = 'apartments' OR k <> 'online.deposit_pct'
  ON CONFLICT (business_unit_id, key) DO NOTHING;
  INSERT INTO user_role_assignment (tenant_id, user_id, role_id, business_unit_id, requested_by)
  SELECT bu.tenant_id, v_agent, r.id, bu.id, NULL FROM role r
   WHERE r.code = 'ONLINE_BOOKING' AND r.tenant_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM user_role_assignment a WHERE a.user_id = v_agent AND a.role_id = r.id
                       AND a.business_unit_id = bu.id AND a.status = 'active');
END $$;

-- Creates the tenant's system account and public address (platform only: runs on the owner connection).
CREATE FUNCTION web.provision_tenant(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_slug text; bu uuid;
BEGIN
  IF web.agent(p_tenant) IS NULL THEN
    INSERT INTO app_user (tenant_id, email, full_name, password_hash, must_change_password, is_system)
    VALUES (p_tenant, 'online+' || replace(p_tenant::text, '-', '') || '@system.invalid', 'Online booking', 'disabled', false, true);
  END IF;
  IF (SELECT public_slug FROM tenant WHERE id = p_tenant) IS NULL THEN
    v_slug := left(trim(both '-' FROM regexp_replace(lower((SELECT name FROM tenant WHERE id = p_tenant)), '[^a-z0-9]+', '-', 'g')), 40);
    IF length(v_slug) < 3 OR EXISTS (SELECT 1 FROM tenant WHERE public_slug = v_slug) THEN
      v_slug := left(v_slug, 31) || '-' || left(replace(p_tenant::text, '-', ''), 8);
    END IF;
    UPDATE tenant SET public_slug = v_slug WHERE id = p_tenant;
  END IF;
  FOR bu IN SELECT id FROM business_unit WHERE tenant_id = p_tenant LOOP
    PERFORM web.provision_unit(bu);
  END LOOP;
END $$;

CREATE FUNCTION web.on_unit_created() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM web.provision_unit(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER provision_online AFTER INSERT ON business_unit FOR EACH ROW EXECUTE FUNCTION web.on_unit_created();

SELECT web.provision_tenant(id) FROM tenant;

-- ---------------------------------------------------------------------
-- Holds and online bookings
-- ---------------------------------------------------------------------
ALTER TABLE reservation ADD COLUMN hold_expires_at timestamptz;
ALTER TABLE appointment ADD COLUMN hold_expires_at timestamptz;

CREATE TYPE online_payment_status AS ENUM ('not_needed', 'pending', 'paid', 'failed', 'expired');

CREATE TABLE online_booking (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  business_unit_id    uuid NOT NULL,
  reservation_id      uuid REFERENCES reservation(id),
  appointment_id      uuid REFERENCES appointment(id),
  customer_id         uuid NOT NULL,
  manage_token_hash   bytea NOT NULL UNIQUE,
  amount_due          numeric(14, 2) NOT NULL CHECK (amount_due >= 0),
  currency            char(3) NOT NULL DEFAULT 'NGN',
  payment_status      online_payment_status NOT NULL,
  payment_reference   text UNIQUE,
  gateway             text,
  gateway_data        jsonb NOT NULL DEFAULT '{}',
  paid_at             timestamptz,
  cancel_requested_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customer(id, tenant_id),
  CHECK ((reservation_id IS NULL) <> (appointment_id IS NULL))
);
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON online_booking FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
ALTER TABLE online_booking ENABLE ROW LEVEL SECURITY;
-- Staff with operations access see the online bookings of their unit; the public pages reach theirs through the token.
CREATE POLICY online_booking_read ON online_booking FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY online_booking_write ON online_booking FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.current_user_id() = web.agent(tenant_id))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.current_user_id() = web.agent(tenant_id));
GRANT SELECT, INSERT ON online_booking TO giddy_app;
GRANT UPDATE (payment_status, payment_reference, gateway, gateway_data, paid_at, cancel_requested_at) ON online_booking TO giddy_app;

-- Public entry point: which tenant a public address belongs to, and its system account.
CREATE FUNCTION web.resolve(p_slug text, OUT tenant_id uuid, OUT tenant_name text, OUT agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, web.agent(t.id) FROM tenant t WHERE t.public_slug = lower(p_slug) AND t.status = 'active'
$$;

-- Which tenant an online booking (by its manage token) or payment reference belongs to.
CREATE FUNCTION web.resolve_booking(p_token_hash bytea, p_reference text, OUT tenant_id uuid, OUT agent_id uuid, OUT booking_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.tenant_id, web.agent(o.tenant_id), o.id FROM online_booking o
   WHERE (p_token_hash IS NOT NULL AND o.manage_token_hash = p_token_hash) OR (p_reference IS NOT NULL AND o.payment_reference = p_reference)
   LIMIT 1
$$;

-- The tenants that have online holds to sweep.
CREATE FUNCTION web.tenants_with_holds() RETURNS TABLE (tenant_id uuid, agent_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT o.tenant_id, web.agent(o.tenant_id) FROM online_booking o WHERE o.payment_status = 'pending'
$$;

-- Releases holds whose payment did not arrive in time (run as the system account).
CREATE FUNCTION web.expire_holds() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o online_booking%ROWTYPE; n integer := 0;
BEGIN
  PERFORM web.require_agent();
  FOR o IN SELECT ob.* FROM online_booking ob
             LEFT JOIN reservation r ON r.id = ob.reservation_id
             LEFT JOIN appointment a ON a.id = ob.appointment_id
            WHERE ob.tenant_id = sec.current_tenant_id() AND ob.payment_status = 'pending'
              AND coalesce(r.hold_expires_at, a.hold_expires_at) < now()
            FOR UPDATE OF ob SKIP LOCKED LOOP
    IF o.reservation_id IS NOT NULL AND (SELECT status FROM reservation WHERE id = o.reservation_id) = 'confirmed' THEN
      PERFORM apt.cancel(o.reservation_id, 'cancelled', 'Online payment not completed in time');
    ELSIF o.appointment_id IS NOT NULL AND (SELECT status FROM appointment WHERE id = o.appointment_id) = 'booked' THEN
      PERFORM bk.cancel(o.appointment_id, 'cancelled', 'Online payment not completed in time', false);
    END IF;
    UPDATE online_booking SET payment_status = 'expired' WHERE id = o.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;


-- Sets (minutes) or clears (NULL) the payment hold on an online booking's reservation or appointment.
CREATE FUNCTION web.set_hold(p_booking uuid, p_minutes integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o online_booking%ROWTYPE; v_until timestamptz;
BEGIN
  PERFORM web.require_agent();
  SELECT * INTO o FROM online_booking WHERE id = p_booking AND tenant_id = sec.current_tenant_id();
  v_until := CASE WHEN p_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => p_minutes) END;
  UPDATE reservation SET hold_expires_at = v_until WHERE id = o.reservation_id;
  UPDATE appointment SET hold_expires_at = v_until WHERE id = o.appointment_id;
END $$;

-- Tells the unit's staff (operations write) about an online booking.
CREATE FUNCTION web.notify(p_bu uuid, p_title text, p_body text, p_link text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM web.require_agent();
  PERFORM sec.notify_unit(p_bu, 'OPS', 'online_booking', p_title, p_body, p_link);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA web FROM PUBLIC;
GRANT EXECUTE ON FUNCTION web.agent(uuid), web.resolve(text), web.resolve_booking(bytea, text), web.tenants_with_holds(),
  web.expire_holds(), web.set_hold(uuid, integer), web.notify(uuid, text, text, text) TO giddy_app;
