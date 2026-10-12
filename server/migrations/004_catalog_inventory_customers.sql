-- =====================================================================
-- 004 Catalogue, suppliers, three-tier inventory, stock ledger, customers
-- =====================================================================

CREATE SCHEMA inv;
REVOKE ALL ON SCHEMA inv FROM PUBLIC;
GRANT USAGE ON SCHEMA inv TO giddy_app;

CREATE TYPE location_tier       AS ENUM ('branch', 'department', 'staff');
CREATE TYPE stock_movement_type AS ENUM ('opening_balance', 'adjustment_in', 'adjustment_out', 'transfer', 'issue', 'wastage');

-- Does the current user hold this data class (at least read, or write) in ANY unit?
CREATE FUNCTION sec.has_any_scope(p_class data_class, p_write boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM user_access_scope s
                 WHERE s.user_id = sec.current_user_id() AND s.data_class = p_class
                   AND (NOT p_write OR s.access_level = 'write'))
$$;

-- Shared master records (items, suppliers) are owned either by the group (owner_business_unit_id NULL,
-- managed by tenant.settings holders) or by one unit (managed by that unit's configuration writers).
CREATE FUNCTION sec.can_manage_master(p_owner_bu uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_owner_bu IS NULL THEN sec.has_perm('tenant.settings')
              ELSE sec.has_scope(p_owner_bu, 'CFG', true) END
$$;

-- =====================================================================
-- Catalogue
-- =====================================================================
CREATE TABLE unit_of_measure (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,15}$'),
  name       text NOT NULL,
  UNIQUE (tenant_id, code),
  UNIQUE (id, tenant_id)
);

CREATE TABLE item_category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  parent_id  uuid,
  name       text NOT NULL,
  UNIQUE NULLS NOT DISTINCT (tenant_id, parent_id, name),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (parent_id, tenant_id) REFERENCES item_category(id, tenant_id),
  CHECK (parent_id IS DISTINCT FROM id)
);

CREATE TABLE item (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenant(id),
  owner_business_unit_id  uuid,                 -- NULL = group-wide item
  sku                     text NOT NULL CHECK (sku ~ '^[A-Z0-9][A-Z0-9._-]{1,39}$'),
  name                    text NOT NULL,
  category_id             uuid,
  base_uom_id             uuid NOT NULL,
  is_stockable            boolean NOT NULL DEFAULT true,
  is_sellable             boolean NOT NULL DEFAULT false,
  is_batch_tracked        boolean NOT NULL DEFAULT false,
  is_expiry_tracked       boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  row_version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, sku),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (category_id, tenant_id) REFERENCES item_category(id, tenant_id),
  FOREIGN KEY (base_uom_id, tenant_id) REFERENCES unit_of_measure(id, tenant_id),
  CHECK (NOT is_expiry_tracked OR is_batch_tracked)
);

-- e.g. 1 crate = 24 bottles: (item = bottled water, uom = crate, factor_to_base = 24)
CREATE TABLE item_uom_conversion (
  tenant_id       uuid NOT NULL,
  item_id         uuid NOT NULL,
  uom_id          uuid NOT NULL,
  factor_to_base  numeric(14, 6) NOT NULL CHECK (factor_to_base > 0),
  PRIMARY KEY (item_id, uom_id),
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (uom_id, tenant_id) REFERENCES unit_of_measure(id, tenant_id)
);

-- An item is usable in a unit only once enabled there. Selling price and reorder rules are per unit (CFG).
CREATE TABLE business_unit_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  item_id           uuid NOT NULL,
  sell_price        numeric(14, 2) CHECK (sell_price >= 0),
  reorder_level     numeric(14, 3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  reorder_qty       numeric(14, 3) NOT NULL DEFAULT 0 CHECK (reorder_qty >= 0),
  is_active         boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, item_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id)
);

-- =====================================================================
-- Suppliers
-- =====================================================================
CREATE TABLE supplier (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenant(id),
  owner_business_unit_id  uuid,
  name                    text NOT NULL,
  contact_name            text,
  phone                   text,
  email                   citext,
  tax_id                  text,
  address                 text,
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  row_version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (owner_business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id)
);

-- A unit's commercial relationship with a supplier: account number and terms (FIN).
CREATE TABLE business_unit_supplier (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  business_unit_id   uuid NOT NULL,
  supplier_id        uuid NOT NULL,
  account_number     text,
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  notes              text,
  is_active          boolean NOT NULL DEFAULT true,
  row_version        integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, supplier_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (supplier_id, tenant_id) REFERENCES supplier(id, tenant_id)
);

-- =====================================================================
-- Inventory: Branch store → Department store → Staff holding
-- =====================================================================
CREATE TABLE stock_location (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  business_unit_id    uuid NOT NULL,
  tier                location_tier NOT NULL,
  name                text NOT NULL,
  branch_id           uuid NOT NULL,
  department_id       uuid,
  staff_user_id       uuid,
  parent_location_id  uuid,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, name),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (branch_id, tenant_id) REFERENCES branch(id, tenant_id),
  FOREIGN KEY (department_id, business_unit_id) REFERENCES department(id, business_unit_id),
  FOREIGN KEY (staff_user_id, tenant_id) REFERENCES app_user(id, tenant_id),
  FOREIGN KEY (parent_location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  CHECK (
    (tier = 'branch'     AND department_id IS NULL     AND staff_user_id IS NULL     AND parent_location_id IS NULL) OR
    (tier = 'department' AND department_id IS NOT NULL AND staff_user_id IS NULL     AND parent_location_id IS NOT NULL) OR
    (tier = 'staff'      AND staff_user_id IS NOT NULL AND parent_location_id IS NOT NULL))
);
-- One staff holding per person per unit.
CREATE UNIQUE INDEX stock_location_staff_uq ON stock_location (business_unit_id, staff_user_id) WHERE tier = 'staff';

-- The parent must be exactly one tier up (department → branch store, staff → department store).
CREATE FUNCTION inv.location_check_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_parent stock_location%ROWTYPE;
BEGIN
  IF NEW.parent_location_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_parent FROM stock_location WHERE id = NEW.parent_location_id;
  IF (NEW.tier = 'department' AND v_parent.tier <> 'branch')
     OR (NEW.tier = 'staff' AND v_parent.tier <> 'department') THEN
    RAISE EXCEPTION 'a % location must sit under a % location', NEW.tier,
      CASE NEW.tier WHEN 'department' THEN 'branch' ELSE 'department' END USING ERRCODE = 'check_violation';
  END IF;
  IF v_parent.branch_id <> NEW.branch_id THEN
    RAISE EXCEPTION 'parent location is in a different branch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tier = 'staff' THEN
    NEW.department_id := v_parent.department_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER location_check_parent BEFORE INSERT OR UPDATE ON stock_location
  FOR EACH ROW EXECUTE FUNCTION inv.location_check_parent();

CREATE TABLE item_batch (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  item_id           uuid NOT NULL,
  batch_no          text NOT NULL,
  mfg_date          date,
  expiry_date       date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, item_id, batch_no),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id),
  CHECK (mfg_date IS NULL OR expiry_date IS NULL OR expiry_date >= mfg_date)
);
CREATE INDEX ON item_batch (item_id, expiry_date);

-- Current quantity per location / item / batch. Written ONLY by inv.post_movement().
CREATE TABLE stock_balance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  location_id       uuid NOT NULL,
  item_id           uuid NOT NULL,
  batch_id          uuid REFERENCES item_batch(id),
  qty_on_hand       numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_balance_slot_uq UNIQUE NULLS NOT DISTINCT (location_id, item_id, batch_id),
  FOREIGN KEY (location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id)
);
CREATE INDEX ON stock_balance (business_unit_id, item_id);

-- The stock ledger. Append-only: every change in quantity is one row here.
CREATE TABLE stock_movement (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  movement_type     stock_movement_type NOT NULL,
  item_id           uuid NOT NULL,
  batch_id          uuid REFERENCES item_batch(id),
  from_location_id  uuid,
  to_location_id    uuid,
  qty               numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_cost         numeric(14, 4) CHECK (unit_cost >= 0),
  reason            text,
  source_doc_type   text NOT NULL DEFAULT 'manual',
  source_doc_id     text,
  posted_by         uuid NOT NULL REFERENCES app_user(id),
  posted_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id),
  FOREIGN KEY (from_location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  FOREIGN KEY (to_location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL),
  CHECK (from_location_id IS DISTINCT FROM to_location_id)
);
CREATE INDEX ON stock_movement (business_unit_id, id DESC);
CREATE INDEX ON stock_movement (item_id, id DESC);

CREATE FUNCTION inv.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON stock_movement
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();

-- =====================================================================
-- Stock posting: the only way quantities change.
--   * Incoming (opening_balance, adjustment_in): p_to required.
--   * Outgoing (adjustment_out, issue, wastage): p_from required.
--   * transfer: both, within the same unit.
-- Batch-tracked items: incoming needs a batch number; outgoing without an explicit
-- batch draws First-Expire-First-Out across unexpired batches.
-- Opening balances and adjustments need CFG write (a manager); the rest need OPS write.
-- Rows are locked in a fixed order (expiry, batch id) so concurrent postings cannot deadlock.
-- =====================================================================
CREATE FUNCTION inv.post_movement(
  p_bu uuid, p_type stock_movement_type, p_item uuid, p_qty numeric,
  p_from uuid DEFAULT NULL, p_to uuid DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL, p_batch_no text DEFAULT NULL,
  p_expiry date DEFAULT NULL, p_mfg date DEFAULT NULL,
  p_unit_cost numeric DEFAULT NULL, p_reason text DEFAULT NULL,
  p_source_type text DEFAULT 'manual', p_source_id text DEFAULT NULL)
RETURNS SETOF bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant   uuid := sec.current_tenant_id();
  v_user     uuid := sec.current_user_id();
  v_item     item%ROWTYPE;
  v_incoming boolean := p_type IN ('opening_balance', 'adjustment_in');
  v_outgoing boolean := p_type IN ('adjustment_out', 'issue', 'wastage');
  v_batch    uuid := p_batch_id;
  v_left     numeric := p_qty;
  v_take     numeric;
  v_id       bigint;
  r          record;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'no user context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_type IN ('opening_balance', 'adjustment_in', 'adjustment_out') THEN
    IF NOT sec.has_scope(p_bu, 'CFG', true) THEN
      RAISE EXCEPTION 'opening balances and adjustments need a manager (configuration write access)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT sec.has_scope(p_bu, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot move stock in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'quantity must be greater than zero' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_item FROM item WHERE id = p_item AND tenant_id = v_tenant;
  IF NOT FOUND OR NOT v_item.is_active OR NOT v_item.is_stockable THEN
    RAISE EXCEPTION 'item is not an active stock item' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_unit_item WHERE business_unit_id = p_bu AND item_id = p_item AND is_active) THEN
    RAISE EXCEPTION 'item is not enabled in this business unit' USING ERRCODE = 'check_violation';
  END IF;

  IF v_incoming AND (p_to IS NULL OR p_from IS NOT NULL)
     OR v_outgoing AND (p_from IS NULL OR p_to IS NOT NULL)
     OR p_type = 'transfer' AND (p_from IS NULL OR p_to IS NULL OR p_from = p_to) THEN
    RAISE EXCEPTION 'locations do not match a % movement', p_type USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_location
             WHERE id IN (p_from, p_to) AND (business_unit_id <> p_bu OR NOT is_active))
     OR (SELECT count(*) FROM stock_location WHERE id IN (p_from, p_to))
        <> (CASE WHEN p_from IS NULL THEN 0 ELSE 1 END + CASE WHEN p_to IS NULL THEN 0 ELSE 1 END) THEN
    RAISE EXCEPTION 'location is not an active location of this unit' USING ERRCODE = 'check_violation';
  END IF;

  IF p_type IN ('adjustment_in', 'adjustment_out') AND coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'adjustments need a reason' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type = 'wastage' AND p_reason NOT IN ('damage', 'expiry', 'theft', 'spillage', 'other') THEN
    RAISE EXCEPTION 'wastage reason must be damage, expiry, theft, spillage or other' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type = 'opening_balance' AND p_unit_cost IS NULL THEN
    RAISE EXCEPTION 'opening balances need a unit cost' USING ERRCODE = 'check_violation';
  END IF;

  -- ---------------- incoming ----------------
  IF v_incoming THEN
    IF v_item.is_batch_tracked THEN
      IF v_batch IS NULL THEN
        IF coalesce(trim(p_batch_no), '') = '' THEN
          RAISE EXCEPTION 'this item is batch-tracked: enter a batch number' USING ERRCODE = 'check_violation';
        END IF;
        IF v_item.is_expiry_tracked AND p_expiry IS NULL THEN
          RAISE EXCEPTION 'this item is expiry-tracked: enter an expiry date' USING ERRCODE = 'check_violation';
        END IF;
        INSERT INTO item_batch (tenant_id, business_unit_id, item_id, batch_no, mfg_date, expiry_date)
        VALUES (v_tenant, p_bu, p_item, trim(p_batch_no), p_mfg, p_expiry)
        ON CONFLICT (business_unit_id, item_id, batch_no) DO NOTHING
        RETURNING id INTO v_batch;
        IF v_batch IS NULL THEN
          SELECT id INTO v_batch FROM item_batch
           WHERE business_unit_id = p_bu AND item_id = p_item AND batch_no = trim(p_batch_no)
             AND expiry_date IS NOT DISTINCT FROM coalesce(p_expiry, expiry_date);
          IF v_batch IS NULL THEN
            RAISE EXCEPTION 'batch % already exists with a different expiry date', p_batch_no USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      ELSIF NOT EXISTS (SELECT 1 FROM item_batch WHERE id = v_batch AND business_unit_id = p_bu AND item_id = p_item) THEN
        RAISE EXCEPTION 'batch does not belong to this item and unit' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF v_batch IS NOT NULL OR p_batch_no IS NOT NULL THEN
      RAISE EXCEPTION 'this item is not batch-tracked' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO stock_balance (tenant_id, business_unit_id, location_id, item_id, batch_id, qty_on_hand)
    VALUES (v_tenant, p_bu, p_to, p_item, v_batch, p_qty)
    ON CONFLICT ON CONSTRAINT stock_balance_slot_uq
      DO UPDATE SET qty_on_hand = stock_balance.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();

    INSERT INTO stock_movement (tenant_id, business_unit_id, movement_type, item_id, batch_id, to_location_id,
                                qty, unit_cost, reason, source_doc_type, source_doc_id, posted_by)
    VALUES (v_tenant, p_bu, p_type, p_item, v_batch, p_to, p_qty, p_unit_cost, p_reason,
            p_source_type, p_source_id, v_user)
    RETURNING id INTO v_id;
    RETURN NEXT v_id;
    RETURN;
  END IF;

  -- ---------------- outgoing / transfer ----------------
  IF v_batch IS NOT NULL AND NOT v_item.is_batch_tracked THEN
    RAISE EXCEPTION 'this item is not batch-tracked' USING ERRCODE = 'check_violation';
  END IF;

  FOR r IN
    SELECT sb.id AS balance_id, sb.batch_id, sb.qty_on_hand
      FROM stock_balance sb
      LEFT JOIN item_batch b ON b.id = sb.batch_id
     WHERE sb.location_id = p_from AND sb.item_id = p_item AND sb.qty_on_hand > 0
       AND (v_batch IS NULL OR sb.batch_id = v_batch)
       -- automatic (FEFO) picks never draw expired stock; an explicit batch may (e.g. writing it off)
       AND (v_batch IS NOT NULL OR b.expiry_date IS NULL OR b.expiry_date >= current_date)
     ORDER BY b.expiry_date NULLS LAST, b.created_at, sb.batch_id
       FOR UPDATE OF sb
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := least(v_left, r.qty_on_hand);
    UPDATE stock_balance SET qty_on_hand = qty_on_hand - v_take, updated_at = now() WHERE id = r.balance_id;
    IF p_type = 'transfer' THEN
      INSERT INTO stock_balance (tenant_id, business_unit_id, location_id, item_id, batch_id, qty_on_hand)
      VALUES (v_tenant, p_bu, p_to, p_item, r.batch_id, v_take)
      ON CONFLICT ON CONSTRAINT stock_balance_slot_uq
        DO UPDATE SET qty_on_hand = stock_balance.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
    END IF;
    INSERT INTO stock_movement (tenant_id, business_unit_id, movement_type, item_id, batch_id, from_location_id,
                                to_location_id, qty, unit_cost, reason, source_doc_type, source_doc_id, posted_by)
    VALUES (v_tenant, p_bu, p_type, p_item, r.batch_id, p_from, CASE WHEN p_type = 'transfer' THEN p_to END,
            v_take, p_unit_cost, p_reason, p_source_type, p_source_id, v_user)
    RETURNING id INTO v_id;
    RETURN NEXT v_id;
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    RAISE EXCEPTION 'not enough stock: % short of %', v_left, p_qty USING ERRCODE = 'check_violation';
  END IF;
  RETURN;
END $$;

-- =====================================================================
-- Customers: one shared identity, private notes per unit
-- =====================================================================
CREATE TABLE customer (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  full_name         text NOT NULL,
  phone             text,
  -- Last 10 digits (the Nigerian national number), so +234 803…, 234-803… and 0803… all match.
  phone_normalized  text GENERATED ALWAYS AS (nullif(right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10), '')) STORED,
  email             citext,
  date_of_birth     date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (id, tenant_id),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX customer_phone_uq ON customer (tenant_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE UNIQUE INDEX customer_email_uq ON customer (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX customer_name_idx ON customer (tenant_id, lower(full_name));

CREATE TABLE customer_unit_profile (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  customer_id       uuid NOT NULL,
  notes             text NOT NULL DEFAULT '',
  tags              text[] NOT NULL DEFAULT '{}',
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, customer_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (customer_id, tenant_id) REFERENCES customer(id, tenant_id)
);

-- =====================================================================
-- Versioning, audit
-- =====================================================================
CREATE TRIGGER item_version     BEFORE UPDATE ON item                   FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER bui_version      BEFORE UPDATE ON business_unit_item     FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER supplier_version BEFORE UPDATE ON supplier               FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER bus_version      BEFORE UPDATE ON business_unit_supplier FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER location_version BEFORE UPDATE ON stock_location         FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER customer_version BEFORE UPDATE ON customer               FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();
CREATE TRIGGER cup_version      BEFORE UPDATE ON customer_unit_profile  FOR EACH ROW EXECUTE FUNCTION sec.bump_row_version();

-- Audit: catalogue and supplier changes are tagged with their owning unit (NULL = group).
CREATE OR REPLACE FUNCTION sec.audit_row() RETURNS trigger
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
               ELSE coalesce(v_row->>'business_unit_id', v_row->>'owner_business_unit_id')::uuid END;
  v_id := coalesce(v_row->>'id', concat_ws(':', v_row->>'business_unit_id', v_row->>'key'));
  PERFORM sec.audit_append((v_row->>'tenant_id')::uuid, v_bu, lower(TG_OP), TG_TABLE_NAME, v_id, v_old, v_new);
  RETURN NULL;
END $$;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON unit_of_measure        FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON item_category          FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON item                   FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON business_unit_item     FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON supplier               FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON business_unit_supplier FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON stock_location         FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON stock_movement                            FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON customer               FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON customer_unit_profile  FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

-- =====================================================================
-- Row-level security
-- =====================================================================
ALTER TABLE unit_of_measure        ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_category          ENABLE ROW LEVEL SECURITY;
ALTER TABLE item                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_uom_conversion    ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit_item     ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier               ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit_supplier ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_location         ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_batch             ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balance          ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement         ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer               ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_unit_profile  ENABLE ROW LEVEL SECURITY;

-- Units of measure and categories: shared vocabulary; any configuration writer may add to it.
CREATE POLICY uom_read  ON unit_of_measure FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY uom_write ON unit_of_measure FOR INSERT TO giddy_app
  WITH CHECK (tenant_id = sec.current_tenant_id() AND (sec.has_perm('tenant.settings') OR sec.has_any_scope('CFG', true)));
CREATE POLICY category_read  ON item_category FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY category_write ON item_category FOR INSERT TO giddy_app
  WITH CHECK (tenant_id = sec.current_tenant_id() AND (sec.has_perm('tenant.settings') OR sec.has_any_scope('CFG', true)));

-- Items and suppliers: everyone in the tenant can see the master record; its owner manages it.
CREATE POLICY item_read  ON item FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY item_write ON item FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.can_manage_master(owner_business_unit_id))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.can_manage_master(owner_business_unit_id));

CREATE POLICY conversion_read  ON item_uom_conversion FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY conversion_write ON item_uom_conversion FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND EXISTS (SELECT 1 FROM item i WHERE i.id = item_id AND sec.can_manage_master(i.owner_business_unit_id)))
  WITH CHECK (tenant_id = sec.current_tenant_id()
         AND EXISTS (SELECT 1 FROM item i WHERE i.id = item_id AND sec.can_manage_master(i.owner_business_unit_id)));

-- Per-unit item settings: read with OPS or CFG read; change with CFG write.
CREATE POLICY bui_read  ON business_unit_item FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND (sec.has_scope(business_unit_id, 'CFG') OR sec.has_scope(business_unit_id, 'OPS')));
CREATE POLICY bui_write ON business_unit_item FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));

CREATE POLICY supplier_read  ON supplier FOR SELECT TO giddy_app USING (tenant_id = sec.current_tenant_id());
CREATE POLICY supplier_write ON supplier FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.can_manage_master(owner_business_unit_id))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.can_manage_master(owner_business_unit_id));

-- A unit's supplier account and terms are financial.
CREATE POLICY bus_read  ON business_unit_supplier FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY bus_write ON business_unit_supplier FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN', true));

-- Stock: read with OPS read in the unit. Locations are configured with CFG write.
-- Balances, batches and movements are written only by inv.post_movement().
CREATE POLICY location_read  ON stock_location FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY location_write ON stock_location FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'CFG', true));
CREATE POLICY batch_read ON item_batch FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY balance_read ON stock_balance FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY movement_read ON stock_movement FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));

-- Customers: the identity is visible to anyone working operations in some unit;
-- each unit's profile (notes, tags) only to that unit.
CREATE POLICY customer_read ON customer FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_any_scope('OPS'));
CREATE POLICY customer_insert ON customer FOR INSERT TO giddy_app
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_any_scope('OPS', true));
CREATE POLICY customer_update ON customer FOR UPDATE TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_any_scope('OPS', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_any_scope('OPS', true));
CREATE POLICY cup_read ON customer_unit_profile FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY cup_write ON customer_unit_profile FOR ALL TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS', true))
  WITH CHECK (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS', true));

-- =====================================================================
-- Grants
-- =====================================================================
GRANT SELECT, INSERT ON unit_of_measure, item_category TO giddy_app;
GRANT SELECT, INSERT, UPDATE ON item, business_unit_item, supplier, business_unit_supplier, stock_location,
                                customer, customer_unit_profile TO giddy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON item_uom_conversion TO giddy_app;
GRANT SELECT ON item_batch, stock_balance, stock_movement TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
REVOKE ALL ON FUNCTION sec.has_any_scope(data_class, boolean), sec.can_manage_master(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sec.has_any_scope(data_class, boolean), sec.can_manage_master(uuid) TO giddy_app;
GRANT EXECUTE ON FUNCTION
  inv.post_movement(uuid, stock_movement_type, uuid, numeric, uuid, uuid, uuid, text, date, date, numeric, text, text, text)
TO giddy_app;
