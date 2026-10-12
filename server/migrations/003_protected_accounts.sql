-- =====================================================================
-- 003 Protected accounts and actor names
--
-- Users who hold a restricted role (System Owner, Business Partner, Group Auditor)
-- are "protected": only a holder of roles.assign_restricted may reset their
-- password, change their email, deactivate them, end their sessions or revoke
-- their restricted role. Without this, IT could take over an owner or partner
-- account by resetting its password.
-- =====================================================================

CREATE FUNCTION sec.is_protected_user(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM user_role_assignment a JOIN role r ON r.id = a.role_id
                 WHERE a.user_id = p_user AND a.status = 'active' AND r.is_restricted)
$$;

-- Display name of whoever made a change, for audit and approval screens. Names only; same tenant only.
CREATE FUNCTION sec.user_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT full_name FROM app_user WHERE id = p_user AND tenant_id = sec.current_tenant_id()
$$;

CREATE FUNCTION sec.app_user_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF sec.current_user_id() IS NOT NULL
     AND NEW.id <> sec.current_user_id()
     AND (NEW.password_hash, NEW.email, NEW.is_active) IS DISTINCT FROM (OLD.password_hash, OLD.email, OLD.is_active)
     AND sec.is_protected_user(NEW.id)
     AND NOT sec.has_perm('roles.assign_restricted') THEN
    RAISE EXCEPTION 'this account is protected; only the system owner can change its credentials or status'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER app_user_guard BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION sec.app_user_guard();

CREATE OR REPLACE FUNCTION sec.revoke_user_sessions(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT sec.has_perm('users.manage') THEN
    RAISE EXCEPTION 'missing permission users.manage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF sec.is_protected_user(p_user) AND p_user <> sec.current_user_id() AND NOT sec.has_perm('roles.assign_restricted') THEN
    RAISE EXCEPTION 'this account is protected' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app_session SET revoked_at = now()
   WHERE user_id = p_user AND tenant_id = sec.current_tenant_id() AND revoked_at IS NULL;
END $$;

-- Revoking a restricted role needs the same permission as granting it.
CREATE OR REPLACE FUNCTION sec.assignment_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_me uuid := sec.current_user_id();
  v_restricted boolean;
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.user_id, NEW.role_id, NEW.business_unit_id, NEW.branch_id, NEW.department_id,
      NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.user_id, OLD.role_id, OLD.business_unit_id, OLD.branch_id, OLD.department_id,
      OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'only the status of an assignment can change' USING ERRCODE = 'check_violation';
  END IF;

  SELECT is_restricted INTO v_restricted FROM role WHERE id = OLD.role_id;

  IF OLD.status = 'pending_approval' AND NEW.status IN ('active', 'rejected') THEN
    IF OLD.business_unit_id IS NULL OR NOT sec.has_perm('grants.approve', OLD.business_unit_id) THEN
      RAISE EXCEPTION 'only a partner of this unit can decide this grant' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.decided_by := v_me;
    NEW.decided_at := now();
  ELSIF OLD.status IN ('pending_approval', 'active') AND NEW.status = 'revoked' THEN
    IF v_restricted AND NOT sec.has_perm('roles.assign_restricted') THEN
      RAISE EXCEPTION 'only the system owner can revoke this role' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_restricted AND OLD.user_id = v_me THEN
      RAISE EXCEPTION 'you cannot revoke your own restricted role' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT (sec.has_perm('roles.assign')
            OR (OLD.business_unit_id IS NOT NULL AND sec.has_perm('grants.approve', OLD.business_unit_id))) THEN
      RAISE EXCEPTION 'missing permission to revoke' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.revoked_by := v_me;
    NEW.revoked_at := now();
  ELSE
    RAISE EXCEPTION 'invalid status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION sec.is_protected_user(uuid), sec.user_name(uuid), sec.app_user_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sec.is_protected_user(uuid), sec.user_name(uuid) TO giddy_app;
