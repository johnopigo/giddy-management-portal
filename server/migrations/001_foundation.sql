-- =====================================================================
-- 001 Foundation: tenancy, organisation, identity, access scope, audit
-- Runs as giddy_owner. The API connects as giddy_app, which is subject
-- to every row-level security policy defined here.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Security helpers live in their own schema; the app may call them but not alter them.
CREATE SCHEMA sec;
REVOKE ALL ON SCHEMA sec FROM PUBLIC;
GRANT USAGE ON SCHEMA sec TO giddy_app;

CREATE TYPE unit_type              AS ENUM ('apartments', 'food_beverage', 'content_studio', 'spa');
CREATE TYPE management_model       AS ENUM ('owner', 'partnership');
CREATE TYPE data_class             AS ENUM ('OPS', 'FIN', 'CFG', 'SEN');
CREATE TYPE access_level           AS ENUM ('read', 'write');          -- ordered: write > read
CREATE TYPE scope_level            AS ENUM ('tenant', 'business_unit', 'branch', 'department', 'self');
CREATE TYPE assignment_status      AS ENUM ('pending_approval', 'active', 'rejected', 'revoked');
CREATE TYPE partnership_visibility AS ENUM ('none', 'read');

-- ---------------------------------------------------------------------
-- Request context. The API sets these with set_config(..., true) inside
-- each transaction, so they can never leak between pooled connections.
-- ---------------------------------------------------------------------
CREATE FUNCTION sec.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION sec.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- =====================================================================
-- Tenancy & organisation
-- =====================================================================
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  tax_id      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE business_unit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  legal_entity_id   uuid NOT NULL,
  code              text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name              text NOT NULL,
  unit_type         unit_type NOT NULL,
  management_model  management_model NOT NULL,
  currency_code     char(3) NOT NULL DEFAULT 'NGN',
  time_zone         text NOT NULL DEFAULT 'Africa/Lagos',
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entity(id, tenant_id)
);

CREATE TABLE branch (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  address     text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id)
);

CREATE TABLE department (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  branch_id         uuid NOT NULL,
  name              text NOT NULL,
  kind              text NOT NULL DEFAULT 'general',
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, branch_id, name),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id)        REFERENCES branch(id, tenant_id)
);

-- Per-unit configuration (tax %, service charge %, policies). Data class CFG.
CREATE TABLE business_unit_setting (
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  key               text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{1,63}$'),
  value             jsonb NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_unit_id, key),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id)
);

-- =====================================================================
-- Identity & access
-- =====================================================================
CREATE TABLE app_user (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  email                 citext NOT NULL UNIQUE,
  full_name             text NOT NULL,
  password_hash         text NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_login_count    integer NOT NULL DEFAULT 0,
  lockout_until         timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  UNIQUE (id, tenant_id)
);

CREATE TABLE permission (
  code         text PRIMARY KEY,
  description  text NOT NULL,
  data_class   data_class,         -- NULL for administrative permissions
  access       access_level,       -- set together with data_class
  is_read_only boolean NOT NULL DEFAULT false,  -- admin permission that only reads (e.g. audit.read)
  CHECK ((data_class IS NULL) = (access IS NULL))
);

CREATE TABLE role (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid REFERENCES tenant(id),   -- NULL = built-in system role
  code                    text NOT NULL,
  name                    text NOT NULL,
  description             text NOT NULL DEFAULT '',
  scope_level             scope_level NOT NULL,
  -- What a tenant-wide assignment of this role grants inside partnership-managed units.
  partnership_visibility  partnership_visibility NOT NULL DEFAULT 'none',
  -- Restricted roles may only be assigned by holders of roles.assign_restricted.
  is_restricted           boolean NOT NULL DEFAULT false,
  -- Role may only be assigned within partnership-managed units.
  partnership_only        boolean NOT NULL DEFAULT false,
  UNIQUE NULLS NOT DISTINCT (tenant_id, code)
);

CREATE TABLE role_permission (
  role_id          uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_code  text NOT NULL REFERENCES permission(code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_role_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  role_id           uuid NOT NULL REFERENCES role(id),
  business_unit_id  uuid,
  branch_id         uuid,
  department_id     uuid,
  status            assignment_status NOT NULL DEFAULT 'pending_approval',
  requested_by      uuid,              -- NULL only for system bootstrap
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid,
  decided_at        timestamptz,
  decision_note     text,
  revoked_by        uuid,
  revoked_at        timestamptz,
  FOREIGN KEY (user_id, tenant_id)          REFERENCES app_user(id, tenant_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id)        REFERENCES branch(id, tenant_id),
  FOREIGN KEY (department_id, business_unit_id) REFERENCES department(id, business_unit_id),
  FOREIGN KEY (requested_by) REFERENCES app_user(id),
  FOREIGN KEY (decided_by)   REFERENCES app_user(id),
  FOREIGN KEY (revoked_by)   REFERENCES app_user(id),
  -- Nobody grants themselves a role, and nobody approves a grant they requested or receive.
  CHECK (requested_by IS NULL OR requested_by <> user_id),
  CHECK (decided_by IS NULL OR (decided_by <> user_id AND decided_by IS DISTINCT FROM requested_by))
);
CREATE INDEX ON user_role_assignment (user_id) WHERE status = 'active';
CREATE INDEX ON user_role_assignment (business_unit_id, status);
-- One live grant of a given role per user per scope.
CREATE UNIQUE INDEX user_role_assignment_live_uq ON user_role_assignment
  (user_id, role_id, coalesce(business_unit_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('pending_approval', 'active');

-- Precomputed "what may this user see" table. Maintained only by sec.rebuild_user_scope().
CREATE TABLE user_access_scope (
  user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL REFERENCES business_unit(id),
  data_class        data_class NOT NULL,
  access_level      access_level NOT NULL,
  PRIMARY KEY (user_id, business_unit_id, data_class)
);

-- Sessions are reachable only through SECURITY DEFINER functions below.
CREATE TABLE app_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  tenant_id     uuid NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  ip            inet,
  user_agent    text
);
CREATE INDEX ON app_session (user_id) WHERE revoked_at IS NULL;

-- =====================================================================
-- Audit log: append-only, hash-chained per tenant
-- =====================================================================
CREATE TABLE audit_log (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid,
  user_id           uuid,
  action            text NOT NULL,
  entity            text NOT NULL,
  entity_id         text,
  before_data       jsonb,
  after_data        jsonb,
  correlation_id    text,
  ip                text,
  at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  prev_hash         bytea,
  row_hash          bytea NOT NULL
);
CREATE INDEX ON audit_log (tenant_id, id);
CREATE INDEX ON audit_log (business_unit_id, id);
CREATE INDEX ON audit_log (entity, entity_id);

CREATE FUNCTION sec.audit_hash(p_prev bytea, p_tenant uuid, p_bu uuid, p_user uuid, p_action text,
                               p_entity text, p_entity_id text, p_before jsonb, p_after jsonb,
                               p_correlation text, p_at timestamptz) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT digest(
    concat_ws('|',
      encode(coalesce(p_prev, ''::bytea), 'hex'), p_tenant, p_bu, p_user, p_action, p_entity, p_entity_id,
      coalesce(p_before::text, ''), coalesce(p_after::text, ''), p_correlation,
      (extract(epoch FROM p_at) * 1000000)::bigint),
    'sha256')
$$;

CREATE FUNCTION sec.audit_append(p_tenant uuid, p_bu uuid, p_action text, p_entity text, p_entity_id text,
                                 p_before jsonb, p_after jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_prev bytea;
  v_at   timestamptz := clock_timestamp();
  v_user uuid := sec.current_user_id();
  v_corr text := nullif(current_setting('app.correlation_id', true), '');
  v_ip   text := nullif(current_setting('app.ip', true), '');
BEGIN
  -- Serialise appends per tenant so the chain has a single, gap-free order.
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || p_tenant::text, 0));
  SELECT row_hash INTO v_prev FROM audit_log WHERE tenant_id = p_tenant ORDER BY id DESC LIMIT 1;
  INSERT INTO audit_log (tenant_id, business_unit_id, user_id, action, entity, entity_id,
                         before_data, after_data, correlation_id, ip, at, prev_hash, row_hash)
  VALUES (p_tenant, p_bu, v_user, p_action, p_entity, p_entity_id, p_before, p_after, v_corr, v_ip, v_at, v_prev,
          sec.audit_hash(v_prev, p_tenant, p_bu, v_user, p_action, p_entity, p_entity_id,
                         p_before, p_after, v_corr, v_at));
END $$;

-- Generic row trigger. Captures before/after images, never secrets.
CREATE FUNCTION sec.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) - 'password_hash' END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) - 'password_hash' END;
  v_row jsonb := coalesce(v_new, v_old);
  v_bu  uuid;
  v_id  text;
BEGIN
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NULL;
  END IF;
  v_bu := CASE WHEN TG_TABLE_NAME = 'business_unit' THEN (v_row->>'id')::uuid
               ELSE (v_row->>'business_unit_id')::uuid END;
  v_id := coalesce(v_row->>'id', concat_ws(':', v_row->>'business_unit_id', v_row->>'key'));
  PERFORM sec.audit_append((v_row->>'tenant_id')::uuid, v_bu, lower(TG_OP), TG_TABLE_NAME, v_id, v_old, v_new);
  RETURN NULL;
END $$;

CREATE FUNCTION sec.audit_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION sec.audit_forbid_change();

-- Walks a tenant's chain; returns the id of the first row that fails verification, or NULL if intact.
CREATE FUNCTION sec.audit_verify_chain(p_tenant uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r      audit_log%ROWTYPE;
  v_prev bytea;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE tenant_id = p_tenant ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM v_prev
       OR r.row_hash <> sec.audit_hash(r.prev_hash, r.tenant_id, r.business_unit_id, r.user_id, r.action,
                                       r.entity, r.entity_id, r.before_data, r.after_data, r.correlation_id, r.at) THEN
      RETURN r.id;
    END IF;
    v_prev := r.row_hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Explicit event entry (logins, approvals) for things that are not a single row change.
CREATE FUNCTION sec.audit_event(p_action text, p_entity text, p_entity_id text, p_bu uuid, p_data jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid := sec.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    SELECT tenant_id INTO v_tenant FROM app_user WHERE id::text = p_entity_id AND p_entity = 'app_user';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'audit_event requires a tenant context';
  END IF;
  PERFORM sec.audit_append(v_tenant, p_bu, p_action, p_entity, p_entity_id, NULL, p_data);
END $$;

-- =====================================================================
-- Access evaluation
-- =====================================================================

-- Recomputes user_access_scope for one user from their active role assignments.
--   * A unit-scoped assignment grants its permissions in that unit.
--   * A tenant-wide assignment grants its permissions in every OWNER-managed unit,
--     and in PARTNERSHIP units only read access (OPS/FIN/CFG, never SEN) when the
--     role's partnership_visibility = 'read'.
CREATE FUNCTION sec.rebuild_user_scope(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM user_access_scope WHERE user_id = p_user;
  INSERT INTO user_access_scope (user_id, tenant_id, business_unit_id, data_class, access_level)
  SELECT a.user_id, a.tenant_id, bu.id, p.data_class,
         max(CASE WHEN a.business_unit_id IS NULL AND bu.management_model = 'partnership'
                  THEN 'read'::access_level ELSE p.access END)
  FROM user_role_assignment a
  JOIN role r             ON r.id = a.role_id
  JOIN role_permission rp ON rp.role_id = r.id
  JOIN permission p       ON p.code = rp.permission_code AND p.data_class IS NOT NULL
  JOIN business_unit bu   ON bu.tenant_id = a.tenant_id
                         AND (bu.id = a.business_unit_id OR a.business_unit_id IS NULL)
  WHERE a.user_id = p_user
    AND a.status = 'active'
    AND (a.business_unit_id IS NOT NULL
         OR bu.management_model = 'owner'
         OR (r.partnership_visibility = 'read' AND p.data_class <> 'SEN'))
  GROUP BY a.user_id, a.tenant_id, bu.id, p.data_class;
END $$;

CREATE FUNCTION sec.rebuild_tenant_scope(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u uuid;
BEGIN
  FOR u IN SELECT id FROM app_user WHERE tenant_id = p_tenant LOOP
    PERFORM sec.rebuild_user_scope(u);
  END LOOP;
END $$;

-- Data-class check used by row-level security policies on business tables.
CREATE FUNCTION sec.has_scope(p_bu uuid, p_class data_class, p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_access_scope s
    WHERE s.user_id = sec.current_user_id()
      AND s.business_unit_id = p_bu
      AND s.data_class = p_class
      AND (NOT p_write OR s.access_level = 'write'))
$$;

-- Administrative permission check.
--   p_bu NULL  → the user holds the permission through a tenant-wide assignment.
--   p_bu given → the user holds it through an assignment in that unit, or through a
--                tenant-wide assignment if the unit is owner-managed (or, for read-only
--                permissions, if the role has partnership read visibility).
CREATE FUNCTION sec.has_perm(p_code text, p_bu uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_role_assignment a
    JOIN role r             ON r.id = a.role_id
    JOIN role_permission rp ON rp.role_id = r.id AND rp.permission_code = p_code
    JOIN permission p       ON p.code = rp.permission_code
    LEFT JOIN business_unit bu ON bu.id = p_bu
    WHERE a.user_id = sec.current_user_id()
      AND a.tenant_id = sec.current_tenant_id()
      AND a.status = 'active'
      AND (
        (p_bu IS NULL AND a.business_unit_id IS NULL)
        OR (p_bu IS NOT NULL AND a.business_unit_id = p_bu)
        OR (p_bu IS NOT NULL AND a.business_unit_id IS NULL
            AND (bu.management_model = 'owner'
                 OR (r.partnership_visibility = 'read' AND p.is_read_only)))))
$$;

-- Can the current user see this user's directory entry?
CREATE FUNCTION sec.can_see_user(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_user = sec.current_user_id()
      OR sec.has_perm('users.read')
      OR EXISTS (SELECT 1 FROM user_role_assignment a
                 WHERE a.user_id = p_user AND a.business_unit_id IS NOT NULL
                   AND a.status IN ('pending_approval', 'active')
                   AND sec.has_perm('grants.approve', a.business_unit_id))
$$;

-- =====================================================================
-- Role assignment rules (enforced in the database, not just the API)
-- =====================================================================
CREATE FUNCTION sec.assignment_before_insert() RETURNS trigger
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

  -- Scope columns must match the role's scope level.
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

  -- Bootstrap rows (requested_by NULL) are only possible for the table owner, never via the API role.
  IF NEW.requested_by IS NULL THEN
    -- session_user, not current_user: inside a SECURITY DEFINER function current_user is the owner.
    IF session_user = 'giddy_app' THEN
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

  -- In a partnership unit, any grant touching finance or configuration waits for a partner's approval.
  -- Restricted roles (the partner role itself) are granted directly by the system owner.
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

CREATE FUNCTION sec.assignment_before_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_me uuid := sec.current_user_id();
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.user_id, NEW.role_id, NEW.business_unit_id, NEW.branch_id, NEW.department_id,
      NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.user_id, OLD.role_id, OLD.business_unit_id, OLD.branch_id, OLD.department_id,
      OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'only the status of an assignment can change' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'pending_approval' AND NEW.status IN ('active', 'rejected') THEN
    IF OLD.business_unit_id IS NULL OR NOT sec.has_perm('grants.approve', OLD.business_unit_id) THEN
      RAISE EXCEPTION 'only a partner of this unit can decide this grant' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.decided_by := v_me;
    NEW.decided_at := now();
  ELSIF OLD.status IN ('pending_approval', 'active') AND NEW.status = 'revoked' THEN
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

CREATE FUNCTION sec.assignment_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM sec.rebuild_user_scope(coalesce(NEW.user_id, OLD.user_id));
  RETURN NULL;
END $$;

CREATE TRIGGER assignment_validate BEFORE INSERT ON user_role_assignment
  FOR EACH ROW EXECUTE FUNCTION sec.assignment_before_insert();
CREATE TRIGGER assignment_transition BEFORE UPDATE ON user_role_assignment
  FOR EACH ROW EXECUTE FUNCTION sec.assignment_before_update();
CREATE TRIGGER assignment_rebuild_scope AFTER INSERT OR UPDATE OR DELETE ON user_role_assignment
  FOR EACH ROW EXECUTE FUNCTION sec.assignment_after_change();

CREATE FUNCTION sec.business_unit_after_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM sec.rebuild_tenant_scope(NEW.tenant_id);
  RETURN NULL;
END $$;

CREATE TRIGGER business_unit_rebuild_scope AFTER INSERT OR UPDATE OF management_model ON business_unit
  FOR EACH ROW EXECUTE FUNCTION sec.business_unit_after_change();

-- Optimistic concurrency + updated_at maintenance.
CREATE FUNCTION sec.bump_row_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.row_version := OLD.row_version + 1;
  IF to_jsonb(NEW) ? 'updated_at' THEN
    NEW := jsonb_populate_record(NEW, jsonb_build_object('updated_at', now()));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER business_unit_version BEFORE UPDATE ON business_unit FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER department_version    BEFORE UPDATE ON department    FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER app_user_version      BEFORE UPDATE ON app_user      FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();

-- Audit triggers on every foundation table that carries business meaning.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON legal_entity          FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON business_unit         FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON branch                FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON department            FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON business_unit_setting FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON user_role_assignment  FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
-- app_user: audit everything except the login bookkeeping columns, which are logged as explicit events.
CREATE TRIGGER audit AFTER INSERT OR DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit_update AFTER UPDATE OF tenant_id, email, full_name, password_hash, is_active, must_change_password
  ON app_user FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

-- =====================================================================
-- Authentication functions (the API role cannot read app_user before login)
-- =====================================================================
CREATE FUNCTION sec.auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, is_active boolean, lockout_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.is_active AND t.status = 'active', u.lockout_until
  FROM app_user u JOIN tenant t ON t.id = u.tenant_id
  WHERE u.email = p_email::citext
$$;

-- After 5 consecutive failures the account locks for 15 minutes.
CREATE FUNCTION sec.auth_login_failed(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_count integer; v_tenant uuid;
BEGIN
  UPDATE app_user
     SET failed_login_count = failed_login_count + 1,
         lockout_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE lockout_until END
   WHERE id = p_user
  RETURNING failed_login_count, tenant_id INTO v_count, v_tenant;
  PERFORM sec.audit_append(v_tenant, NULL, CASE WHEN v_count >= 5 THEN 'login_locked' ELSE 'login_failed' END,
                           'app_user', p_user::text, NULL, jsonb_build_object('failed_count', v_count));
END $$;

CREATE FUNCTION sec.auth_login_succeeded(p_user uuid, p_token_hash bytea, p_ttl interval, p_ip inet, p_user_agent text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid;
BEGIN
  UPDATE app_user SET failed_login_count = 0, lockout_until = NULL, last_login_at = now()
   WHERE id = p_user RETURNING tenant_id INTO v_tenant;
  INSERT INTO app_session (user_id, tenant_id, token_hash, expires_at, ip, user_agent)
  VALUES (p_user, v_tenant, p_token_hash, now() + p_ttl, p_ip, p_user_agent);
  PERFORM sec.audit_append(v_tenant, NULL, 'login', 'app_user', p_user::text, NULL, NULL);
END $$;

CREATE FUNCTION sec.session_resolve(p_token_hash bytea)
RETURNS TABLE (user_id uuid, tenant_id uuid, must_change_password boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE app_session s SET last_seen_at = now()
    FROM app_user u, tenant t
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
     AND u.id = s.user_id AND u.is_active AND t.id = u.tenant_id AND t.status = 'active'
  RETURNING s.user_id, s.tenant_id, u.must_change_password;
END $$;

CREATE FUNCTION sec.session_revoke(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE app_session SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL
$$;

-- Self-service password change; revokes every other session of the user.
CREATE FUNCTION sec.change_own_password(p_new_hash text, p_keep_token_hash bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE app_user SET password_hash = p_new_hash, must_change_password = false WHERE id = sec.current_user_id();
  UPDATE app_session SET revoked_at = now()
   WHERE user_id = sec.current_user_id() AND revoked_at IS NULL AND token_hash <> p_keep_token_hash;
END $$;

-- Admin reset / deactivation ends every session of the target user.
CREATE FUNCTION sec.revoke_user_sessions(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT sec.has_perm('users.manage') THEN
    RAISE EXCEPTION 'missing permission users.manage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE app_session SET revoked_at = now()
   WHERE user_id = p_user AND tenant_id = sec.current_tenant_id() AND revoked_at IS NULL;
END $$;

CREATE FUNCTION sec.verify_my_tenant_audit() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- The result reveals only whether the chain is intact, so audit access in any unit is enough.
  IF NOT EXISTS (SELECT 1 FROM user_role_assignment a
                 JOIN role_permission rp ON rp.role_id = a.role_id
                 WHERE a.user_id = sec.current_user_id() AND a.status = 'active'
                   AND rp.permission_code IN ('audit.read', 'audit.read_security')) THEN
    RAISE EXCEPTION 'missing permission audit.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN sec.audit_verify_chain(sec.current_tenant_id());
END $$;

-- =====================================================================
-- Row-level security
-- =====================================================================
ALTER TABLE tenant                ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_entity          ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit         ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch                ENABLE ROW LEVEL SECURITY;
ALTER TABLE department            ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user              ENABLE ROW LEVEL SECURITY;
ALTER TABLE role                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permission       ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role_assignment  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_access_scope     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_session           ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON tenant FOR SELECT TO giddy_app USING (id = sec.current_tenant_id());

-- Organisation structure is visible tenant-wide (it is needed to assign roles); only owners change it.
CREATE POLICY legal_entity_read  ON legal_entity FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY legal_entity_write ON legal_entity FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_perm('tenant.settings'))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_perm('tenant.settings'));

CREATE POLICY business_unit_read  ON business_unit FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY business_unit_write ON business_unit FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_perm('tenant.settings'))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_perm('tenant.settings'));

CREATE POLICY branch_read  ON branch FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY branch_write ON branch FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_perm('tenant.settings'))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_perm('tenant.settings'));

-- Departments: visible tenant-wide; changed by whoever holds CFG write in that unit.
CREATE POLICY department_read  ON department FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY department_write ON department FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));

-- Unit settings: the template for every business table — read needs CFG read, write needs CFG write.
CREATE POLICY setting_read  ON business_unit_setting FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG'));
CREATE POLICY setting_write ON business_unit_setting FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));

CREATE POLICY app_user_read ON app_user FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.can_see_user(id));
CREATE POLICY app_user_insert ON app_user FOR INSERT TO giddy_app
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_perm('users.manage'));
CREATE POLICY app_user_update ON app_user FOR UPDATE TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_perm('users.manage'))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_perm('users.manage'));

CREATE POLICY permission_read ON permission FOR SELECT TO giddy_app USING (true);
CREATE POLICY role_read ON role FOR SELECT TO giddy_app
  USING (tenant_id IS NULL OR tenant_id = sec.current_tenant_id());
CREATE POLICY role_permission_read ON role_permission FOR SELECT TO giddy_app
  USING (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id
                 AND (r.tenant_id IS NULL OR r.tenant_id = sec.current_tenant_id())));

CREATE POLICY assignment_read ON user_role_assignment FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND (user_id = sec.current_user_id()
              OR sec.has_perm('users.read')
              OR (business_unit_id IS NOT NULL AND sec.has_perm('grants.approve', business_unit_id))));
-- Detailed rules (who may grant what, approvals) live in the assignment triggers above.
CREATE POLICY assignment_insert ON user_role_assignment FOR INSERT TO giddy_app
  WITH CHECK (tenant_id = sec.current_tenant_id());
CREATE POLICY assignment_update ON user_role_assignment FOR UPDATE TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND (sec.has_perm('roles.assign')
              OR (business_unit_id IS NOT NULL AND sec.has_perm('grants.approve', business_unit_id))))
  WITH CHECK (tenant_id = sec.current_tenant_id());

CREATE POLICY scope_read ON user_access_scope FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND (user_id = sec.current_user_id() OR sec.has_perm('users.read')));

-- No policy on app_session → the API role can only reach it through the functions above.

CREATE POLICY audit_read ON audit_log FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND ((business_unit_id IS NULL AND sec.has_perm('audit.read'))
              OR (business_unit_id IS NOT NULL AND sec.has_perm('audit.read', business_unit_id))
              OR (entity IN ('app_user', 'user_role_assignment') AND sec.has_perm('audit.read_security'))));

-- =====================================================================
-- Grants to the API role
-- =====================================================================
GRANT SELECT ON tenant, permission, role, role_permission, user_access_scope, audit_log TO giddy_app;
GRANT SELECT, INSERT, UPDATE ON legal_entity, business_unit, branch, department TO giddy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON business_unit_setting TO giddy_app;
GRANT SELECT, INSERT, UPDATE ON user_role_assignment TO giddy_app;
GRANT SELECT, INSERT ON app_user TO giddy_app;
-- Login bookkeeping columns are only writable through the auth functions.
GRANT UPDATE (full_name, email, password_hash, is_active, must_change_password) ON app_user TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sec FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  sec.current_user_id(), sec.current_tenant_id(),
  sec.has_scope(uuid, data_class, boolean), sec.has_perm(text, uuid), sec.can_see_user(uuid),
  sec.auth_lookup(text), sec.auth_login_failed(uuid),
  sec.auth_login_succeeded(uuid, bytea, interval, inet, text),
  sec.session_resolve(bytea), sec.session_revoke(bytea),
  sec.change_own_password(text, bytea), sec.revoke_user_sessions(uuid),
  sec.audit_event(text, text, text, uuid, jsonb), sec.verify_my_tenant_audit()
TO giddy_app;
