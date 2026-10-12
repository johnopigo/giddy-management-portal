-- =====================================================================
-- 005 Procurement: average costing, purchase orders, goods receipts,
--     inter-unit transfers, staff item requests, in-app notifications
-- =====================================================================

-- New movement types. (Added in this migration's transaction; only referenced from
-- function bodies, which are not executed until after commit.)
ALTER TYPE stock_movement_type ADD VALUE 'receipt';
ALTER TYPE stock_movement_type ADD VALUE 'inter_unit_out';
ALTER TYPE stock_movement_type ADD VALUE 'inter_unit_in';

-- =====================================================================
-- Notifications
-- =====================================================================
CREATE TABLE notification (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  user_id           uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  business_unit_id  uuid REFERENCES business_unit(id),
  kind              text NOT NULL,
  title             text NOT NULL,
  body              text NOT NULL DEFAULT '',
  link              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  read_at           timestamptz
);
CREATE INDEX ON notification (user_id, id DESC);
CREATE INDEX ON notification (user_id) WHERE read_at IS NULL;

-- Notify everyone holding WRITE on a data class in a unit (e.g. CFG write = the unit's managers).
CREATE FUNCTION sec.notify_unit(p_bu uuid, p_class data_class, p_kind text, p_title text, p_body text, p_link text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO notification (tenant_id, user_id, business_unit_id, kind, title, body, link)
  SELECT s.tenant_id, s.user_id, p_bu, p_kind, p_title, coalesce(p_body, ''), p_link
    FROM user_access_scope s JOIN app_user u ON u.id = s.user_id AND u.is_active
   WHERE s.business_unit_id = p_bu AND s.data_class = p_class AND s.access_level = 'write'
     AND s.user_id IS DISTINCT FROM sec.current_user_id()
$$;

CREATE FUNCTION sec.notify_user(p_user uuid, p_bu uuid, p_kind text, p_title text, p_body text, p_link text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO notification (tenant_id, user_id, business_unit_id, kind, title, body, link)
  SELECT u.tenant_id, u.id, p_bu, p_kind, p_title, coalesce(p_body, ''), p_link
    FROM app_user u WHERE u.id = p_user AND u.is_active AND p_user IS DISTINCT FROM sec.current_user_id()
$$;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_own ON notification FOR SELECT TO giddy_app USING (user_id = sec.current_user_id());
CREATE POLICY notification_mark_read ON notification FOR UPDATE TO giddy_app
  USING (user_id = sec.current_user_id()) WITH CHECK (user_id = sec.current_user_id());
GRANT SELECT ON notification TO giddy_app;
GRANT UPDATE (read_at) ON notification TO giddy_app;

-- =====================================================================
-- Document numbers: PO-FNB-000001, GRN-..., TRF-..., REQ-...
-- =====================================================================
CREATE TABLE doc_sequence (
  business_unit_id  uuid NOT NULL REFERENCES business_unit(id),
  prefix            text NOT NULL,
  next_no           bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (business_unit_id, prefix)
);

CREATE FUNCTION inv.next_doc_number(p_bu uuid, p_prefix text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_no bigint; v_code text;
BEGIN
  INSERT INTO doc_sequence (business_unit_id, prefix) VALUES (p_bu, p_prefix) ON CONFLICT DO NOTHING;
  UPDATE doc_sequence SET next_no = next_no + 1
   WHERE business_unit_id = p_bu AND prefix = p_prefix RETURNING next_no - 1 INTO v_no;
  SELECT code INTO v_code FROM business_unit WHERE id = p_bu;
  RETURN p_prefix || '-' || v_code || '-' || lpad(v_no::text, 6, '0');
END $$;

-- =====================================================================
-- Moving average cost per unit and item (financial)
-- =====================================================================
CREATE TABLE item_cost (
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  item_id           uuid NOT NULL,
  avg_unit_cost     numeric(14, 4) NOT NULL DEFAULT 0 CHECK (avg_unit_cost >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_unit_id, item_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id)
);
ALTER TABLE item_cost ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_cost_read ON item_cost FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
GRANT SELECT ON item_cost TO giddy_app;

-- Direction of each movement type: 'in', 'out' or 'move' (between two locations of one unit).
-- Later stages add movement types by replacing only this function.
CREATE FUNCTION inv.movement_direction(p_type stock_movement_type) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type::text
    WHEN 'opening_balance' THEN 'in' WHEN 'adjustment_in' THEN 'in' WHEN 'receipt' THEN 'in' WHEN 'inter_unit_in' THEN 'in'
    WHEN 'adjustment_out' THEN 'out' WHEN 'issue' THEN 'out' WHEN 'wastage' THEN 'out' WHEN 'inter_unit_out' THEN 'out'
    WHEN 'transfer' THEN 'move'
  END
$$;

-- =====================================================================
-- inv.apply_movement: the single stock engine. NO permission checks — callers check.
-- Not executable by the API role; only reachable through the checked wrappers below.
--
-- Costing (moving weighted average per unit + item):
--   * incoming WITH a cost (opening, receipt, inter-unit in, costed adjustment) re-averages;
--   * every other movement is valued at the current average.
-- =====================================================================
CREATE FUNCTION inv.apply_movement(
  p_bu uuid, p_type stock_movement_type, p_item uuid, p_qty numeric,
  p_from uuid, p_to uuid, p_batch_id uuid, p_batch_no text, p_expiry date, p_mfg date,
  p_unit_cost numeric, p_reason text, p_source_type text, p_source_id text)
RETURNS SETOF bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant   uuid := sec.current_tenant_id();
  v_user     uuid := sec.current_user_id();
  v_item     item%ROWTYPE;
  v_incoming boolean := inv.movement_direction(p_type) = 'in';
  v_outgoing boolean := inv.movement_direction(p_type) = 'out';
  v_batch    uuid := p_batch_id;
  v_left     numeric := p_qty;
  v_take     numeric;
  v_id       bigint;
  v_avg      numeric;
  v_on_hand  numeric;
  v_cost     numeric;
  v_reorder  numeric;
  r          record;
BEGIN
  IF v_tenant IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'no user context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RAISE EXCEPTION 'quantity must be greater than zero' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_item FROM item WHERE id = p_item AND tenant_id = v_tenant;
  IF NOT FOUND OR NOT v_item.is_active OR NOT v_item.is_stockable THEN
    RAISE EXCEPTION 'item is not an active stock item' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_unit_item WHERE business_unit_id = p_bu AND item_id = p_item AND is_active) THEN
    RAISE EXCEPTION 'item % is not enabled in this business unit', v_item.name USING ERRCODE = 'check_violation';
  END IF;

  IF inv.movement_direction(p_type) IS NULL THEN
    RAISE EXCEPTION 'unknown movement type %', p_type;
  END IF;
  IF v_incoming AND (p_to IS NULL OR p_from IS NOT NULL)
     OR v_outgoing AND (p_from IS NULL OR p_to IS NOT NULL)
     OR NOT v_incoming AND NOT v_outgoing AND (p_from IS NULL OR p_to IS NULL OR p_from = p_to) THEN
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
  IF p_type IN ('opening_balance', 'receipt', 'inter_unit_in') AND p_unit_cost IS NULL THEN
    RAISE EXCEPTION '% needs a unit cost', p_type USING ERRCODE = 'check_violation';
  END IF;

  -- Current average (row created on first use; locked when it may change).
  INSERT INTO item_cost (tenant_id, business_unit_id, item_id) VALUES (v_tenant, p_bu, p_item) ON CONFLICT DO NOTHING;

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

    SELECT avg_unit_cost INTO v_avg FROM item_cost WHERE business_unit_id = p_bu AND item_id = p_item FOR UPDATE;
    IF p_unit_cost IS NOT NULL THEN
      SELECT coalesce(sum(qty_on_hand), 0) INTO v_on_hand FROM stock_balance WHERE business_unit_id = p_bu AND item_id = p_item;
      UPDATE item_cost
         SET avg_unit_cost = CASE WHEN v_on_hand <= 0 THEN p_unit_cost
                                  ELSE round((v_on_hand * v_avg + p_qty * p_unit_cost) / (v_on_hand + p_qty), 4) END,
             updated_at = now()
       WHERE business_unit_id = p_bu AND item_id = p_item;
      v_cost := p_unit_cost;
    ELSE
      v_cost := v_avg;
    END IF;

    INSERT INTO stock_balance (tenant_id, business_unit_id, location_id, item_id, batch_id, qty_on_hand)
    VALUES (v_tenant, p_bu, p_to, p_item, v_batch, p_qty)
    ON CONFLICT ON CONSTRAINT stock_balance_slot_uq
      DO UPDATE SET qty_on_hand = stock_balance.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();

    INSERT INTO stock_movement (tenant_id, business_unit_id, movement_type, item_id, batch_id, to_location_id,
                                qty, unit_cost, reason, source_doc_type, source_doc_id, posted_by)
    VALUES (v_tenant, p_bu, p_type, p_item, v_batch, p_to, p_qty, v_cost, p_reason, p_source_type, p_source_id, v_user)
    RETURNING id INTO v_id;
    RETURN NEXT v_id;
    RETURN;
  END IF;

  -- ---------------- outgoing / transfer ----------------
  IF v_batch IS NOT NULL AND NOT v_item.is_batch_tracked THEN
    RAISE EXCEPTION 'this item is not batch-tracked' USING ERRCODE = 'check_violation';
  END IF;
  SELECT avg_unit_cost INTO v_avg FROM item_cost WHERE business_unit_id = p_bu AND item_id = p_item;

  FOR r IN
    SELECT sb.id AS balance_id, sb.batch_id, sb.qty_on_hand
      FROM stock_balance sb
      LEFT JOIN item_batch b ON b.id = sb.batch_id
     WHERE sb.location_id = p_from AND sb.item_id = p_item AND sb.qty_on_hand > 0
       AND (v_batch IS NULL OR sb.batch_id = v_batch)
       AND (v_batch IS NOT NULL OR b.expiry_date IS NULL OR b.expiry_date >= current_date)
     ORDER BY b.expiry_date NULLS LAST, b.created_at, sb.batch_id
       FOR UPDATE OF sb
  LOOP
    EXIT WHEN v_left <= 0;
    v_take := least(v_left, r.qty_on_hand);
    UPDATE stock_balance SET qty_on_hand = qty_on_hand - v_take, updated_at = now() WHERE id = r.balance_id;
    IF NOT v_outgoing THEN
      INSERT INTO stock_balance (tenant_id, business_unit_id, location_id, item_id, batch_id, qty_on_hand)
      VALUES (v_tenant, p_bu, p_to, p_item, r.batch_id, v_take)
      ON CONFLICT ON CONSTRAINT stock_balance_slot_uq
        DO UPDATE SET qty_on_hand = stock_balance.qty_on_hand + EXCLUDED.qty_on_hand, updated_at = now();
    END IF;
    INSERT INTO stock_movement (tenant_id, business_unit_id, movement_type, item_id, batch_id, from_location_id,
                                to_location_id, qty, unit_cost, reason, source_doc_type, source_doc_id, posted_by)
    VALUES (v_tenant, p_bu, p_type, p_item, r.batch_id, p_from, CASE WHEN NOT v_outgoing THEN p_to END,
            v_take, v_avg, p_reason, p_source_type, p_source_id, v_user)
    RETURNING id INTO v_id;
    RETURN NEXT v_id;
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    RAISE EXCEPTION 'not enough stock of %: % short of %', v_item.name, v_left, p_qty USING ERRCODE = 'check_violation';
  END IF;

  -- Low-stock alert when this movement takes the unit's total to or below the reorder level.
  IF v_outgoing THEN
    SELECT reorder_level INTO v_reorder FROM business_unit_item WHERE business_unit_id = p_bu AND item_id = p_item;
    SELECT coalesce(sum(qty_on_hand), 0) INTO v_on_hand FROM stock_balance WHERE business_unit_id = p_bu AND item_id = p_item;
    IF v_reorder > 0 AND v_on_hand <= v_reorder AND v_on_hand + p_qty > v_reorder THEN
      PERFORM sec.notify_unit(p_bu, 'CFG', 'low_stock', v_item.name || ' is low',
        format('%s left; reorder level is %s.', trim_scale(v_on_hand), trim_scale(v_reorder)), '/inventory');
    END IF;
  END IF;
  RETURN;
END $$;

-- The manual movement endpoint: same signature as before, now a checked wrapper.
-- Receipts and inter-unit movements can only come from their documents.
CREATE OR REPLACE FUNCTION inv.post_movement(
  p_bu uuid, p_type stock_movement_type, p_item uuid, p_qty numeric,
  p_from uuid DEFAULT NULL, p_to uuid DEFAULT NULL,
  p_batch_id uuid DEFAULT NULL, p_batch_no text DEFAULT NULL,
  p_expiry date DEFAULT NULL, p_mfg date DEFAULT NULL,
  p_unit_cost numeric DEFAULT NULL, p_reason text DEFAULT NULL,
  p_source_type text DEFAULT 'manual', p_source_id text DEFAULT NULL)
RETURNS SETOF bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_type::text NOT IN ('opening_balance', 'adjustment_in', 'adjustment_out', 'transfer', 'issue', 'wastage') THEN
    RAISE EXCEPTION '% movements are recorded from their documents (orders, transfers, sales)', p_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_type IN ('opening_balance', 'adjustment_in', 'adjustment_out') THEN
    IF NOT sec.has_scope(p_bu, 'CFG', true) THEN
      RAISE EXCEPTION 'opening balances and adjustments need a manager (configuration write access)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT sec.has_scope(p_bu, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot move stock in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM inv.apply_movement(p_bu, p_type, p_item, p_qty, p_from, p_to, p_batch_id, p_batch_no,
                                                p_expiry, p_mfg, p_unit_cost, p_reason, p_source_type, p_source_id);
END $$;

-- =====================================================================
-- Purchase orders and goods receipts (FIN data: they carry prices)
-- =====================================================================
CREATE TYPE po_status AS ENUM ('draft', 'submitted', 'approved', 'partially_received', 'received', 'closed', 'cancelled');

CREATE TABLE purchase_order (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  po_number         text NOT NULL,
  supplier_id       uuid NOT NULL,
  status            po_status NOT NULL DEFAULT 'draft',
  expected_date     date,
  notes             text NOT NULL DEFAULT '',
  rejection_note    text,
  created_by        uuid NOT NULL REFERENCES app_user(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  submitted_by      uuid REFERENCES app_user(id),
  submitted_at      timestamptz,
  approved_by       uuid REFERENCES app_user(id),
  approved_at       timestamptz,
  closed_by         uuid REFERENCES app_user(id),
  closed_at         timestamptz,
  close_reason      text,
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, po_number),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (supplier_id, tenant_id) REFERENCES supplier(id, tenant_id)
);
CREATE INDEX ON purchase_order (business_unit_id, status);

CREATE TABLE purchase_order_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  line_no           integer NOT NULL,
  item_id           uuid NOT NULL,
  qty_ordered       numeric(14, 3) NOT NULL CHECK (qty_ordered > 0),
  unit_cost         numeric(14, 4) NOT NULL CHECK (unit_cost >= 0),
  qty_received      numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0 AND qty_received <= qty_ordered),
  UNIQUE (purchase_order_id, line_no),
  UNIQUE (purchase_order_id, item_id),
  FOREIGN KEY (purchase_order_id, business_unit_id) REFERENCES purchase_order(id, business_unit_id) ON DELETE CASCADE,
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id)
);

CREATE TABLE goods_receipt (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  business_unit_id      uuid NOT NULL,
  receipt_number        text NOT NULL,
  purchase_order_id     uuid NOT NULL,
  location_id           uuid NOT NULL,
  supplier_invoice_ref  text,
  notes                 text NOT NULL DEFAULT '',
  received_by           uuid NOT NULL REFERENCES app_user(id),
  received_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, receipt_number),
  FOREIGN KEY (purchase_order_id, business_unit_id) REFERENCES purchase_order(id, business_unit_id),
  FOREIGN KEY (location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id)
);

CREATE TABLE goods_receipt_line (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  business_unit_id       uuid NOT NULL,
  goods_receipt_id       uuid NOT NULL REFERENCES goods_receipt(id),
  purchase_order_line_id uuid NOT NULL REFERENCES purchase_order_line(id),
  item_id                uuid NOT NULL,
  qty                    numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_cost              numeric(14, 4) NOT NULL,
  batch_no               text,
  expiry_date            date,
  movement_id            bigint NOT NULL REFERENCES stock_movement(id)
);

CREATE TRIGGER goods_receipt_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON goods_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();
CREATE TRIGGER goods_receipt_line_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON goods_receipt_line
  FOR EACH STATEMENT EXECUTE FUNCTION inv.forbid_change();

-- Who may do what with a purchase order:
--   draft / submit / cancel own draft : OPS write + FIN read  (storekeeper, manager)
--   approve / reject / close / cancel : CFG write + FIN read  (unit manager, owner, partner)
--   receive                           : OPS write
-- Segregation of duties: you cannot approve a PO you submitted, unless you also hold FIN write
-- (the owner or partner, who answer for the money themselves).
CREATE FUNCTION inv.po_check(p_bu uuid, p_action text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_action = 'draft' AND NOT (sec.has_scope(p_bu, 'OPS', true) AND sec.has_scope(p_bu, 'FIN')) THEN
    RAISE EXCEPTION 'you cannot raise purchase orders in this unit' USING ERRCODE = 'insufficient_privilege';
  ELSIF p_action = 'approve' AND NOT (sec.has_scope(p_bu, 'CFG', true) AND sec.has_scope(p_bu, 'FIN')) THEN
    RAISE EXCEPTION 'only a manager of this unit can do that' USING ERRCODE = 'insufficient_privilege';
  ELSIF p_action = 'receive' AND NOT sec.has_scope(p_bu, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot receive goods in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Lines: [{"itemId": uuid, "qty": n, "unitCost": n}, ...]
CREATE FUNCTION inv.po_save_draft(p_po uuid, p_bu uuid, p_supplier uuid, p_expected date, p_notes text, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_po    purchase_order%ROWTYPE;
  v_id    uuid := p_po;
  v_line  jsonb;
  v_no    integer := 0;
BEGIN
  PERFORM inv.po_check(p_bu, 'draft');
  IF NOT EXISTS (SELECT 1 FROM supplier WHERE id = p_supplier AND tenant_id = sec.current_tenant_id() AND is_active) THEN
    RAISE EXCEPTION 'supplier not found or inactive' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'a purchase order needs at least one line' USING ERRCODE = 'check_violation';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO purchase_order (tenant_id, business_unit_id, po_number, supplier_id, expected_date, notes, created_by)
    VALUES (sec.current_tenant_id(), p_bu, inv.next_doc_number(p_bu, 'PO'), p_supplier, p_expected,
            coalesce(p_notes, ''), sec.current_user_id())
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_po FROM purchase_order WHERE id = v_id AND business_unit_id = p_bu FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'purchase order not found' USING ERRCODE = 'no_data_found'; END IF;
    IF v_po.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft purchase orders can be edited' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE purchase_order SET supplier_id = p_supplier, expected_date = p_expected, notes = coalesce(p_notes, ''),
           row_version = row_version + 1
     WHERE id = v_id;
    DELETE FROM purchase_order_line WHERE purchase_order_id = v_id;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_no := v_no + 1;
    IF NOT EXISTS (SELECT 1 FROM business_unit_item bui JOIN item i ON i.id = bui.item_id
                    WHERE bui.business_unit_id = p_bu AND bui.item_id = (v_line->>'itemId')::uuid
                      AND bui.is_active AND i.is_active AND i.is_stockable) THEN
      RAISE EXCEPTION 'line %: item is not an active stock item of this unit', v_no USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO purchase_order_line (tenant_id, business_unit_id, purchase_order_id, line_no, item_id, qty_ordered, unit_cost)
    VALUES (sec.current_tenant_id(), p_bu, v_id, v_no, (v_line->>'itemId')::uuid,
            (v_line->>'qty')::numeric, (v_line->>'unitCost')::numeric);
  END LOOP;
  RETURN v_id;
END $$;

CREATE FUNCTION inv.po_transition(p_po uuid, p_action text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_po purchase_order%ROWTYPE;
  v_me uuid := sec.current_user_id();
BEGIN
  SELECT * INTO v_po FROM purchase_order WHERE id = p_po AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(v_po.business_unit_id, 'FIN') THEN
    RAISE EXCEPTION 'purchase order not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_action = 'submit' THEN
    PERFORM inv.po_check(v_po.business_unit_id, 'draft');
    IF v_po.status <> 'draft' THEN RAISE EXCEPTION 'only a draft can be submitted' USING ERRCODE = 'check_violation'; END IF;
    UPDATE purchase_order SET status = 'submitted', submitted_by = v_me, submitted_at = now(), rejection_note = NULL,
           row_version = row_version + 1 WHERE id = p_po;
    PERFORM sec.notify_unit(v_po.business_unit_id, 'CFG', 'po_submitted', v_po.po_number || ' needs approval',
                            'Submitted by ' || sec.user_name(v_me) || '.', '/procurement?po=' || p_po);

  ELSIF p_action = 'approve' THEN
    PERFORM inv.po_check(v_po.business_unit_id, 'approve');
    IF v_po.status <> 'submitted' THEN RAISE EXCEPTION 'only a submitted order can be approved' USING ERRCODE = 'check_violation'; END IF;
    IF v_po.submitted_by = v_me AND NOT sec.has_scope(v_po.business_unit_id, 'FIN', true) THEN
      RAISE EXCEPTION 'you cannot approve a purchase order you submitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE purchase_order SET status = 'approved', approved_by = v_me, approved_at = now(),
           row_version = row_version + 1 WHERE id = p_po;
    PERFORM sec.notify_user(v_po.submitted_by, v_po.business_unit_id, 'po_approved', v_po.po_number || ' approved',
                            'Approved by ' || sec.user_name(v_me) || '. Goods can now be received.', '/procurement?po=' || p_po);

  ELSIF p_action = 'reject' THEN
    PERFORM inv.po_check(v_po.business_unit_id, 'approve');
    IF v_po.status <> 'submitted' THEN RAISE EXCEPTION 'only a submitted order can be sent back' USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(trim(p_note), '') = '' THEN RAISE EXCEPTION 'give a reason for sending it back' USING ERRCODE = 'check_violation'; END IF;
    UPDATE purchase_order SET status = 'draft', rejection_note = p_note, submitted_by = NULL, submitted_at = NULL,
           row_version = row_version + 1 WHERE id = p_po;
    PERFORM sec.notify_user(v_po.submitted_by, v_po.business_unit_id, 'po_rejected', v_po.po_number || ' sent back',
                            p_note, '/procurement?po=' || p_po);

  ELSIF p_action = 'cancel' THEN
    IF v_po.status IN ('draft', 'submitted') AND v_po.created_by = v_me THEN
      PERFORM inv.po_check(v_po.business_unit_id, 'draft');
    ELSE
      PERFORM inv.po_check(v_po.business_unit_id, 'approve');
    END IF;
    IF v_po.status NOT IN ('draft', 'submitted', 'approved') THEN
      RAISE EXCEPTION 'orders with goods received cannot be cancelled; close them instead' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE purchase_order SET status = 'cancelled', closed_by = v_me, closed_at = now(), close_reason = p_note,
           row_version = row_version + 1 WHERE id = p_po;

  ELSIF p_action = 'close' THEN
    PERFORM inv.po_check(v_po.business_unit_id, 'approve');
    IF v_po.status <> 'partially_received' THEN
      RAISE EXCEPTION 'only a partly received order can be closed short' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(trim(p_note), '') = '' THEN RAISE EXCEPTION 'give a reason for closing it' USING ERRCODE = 'check_violation'; END IF;
    UPDATE purchase_order SET status = 'closed', closed_by = v_me, closed_at = now(), close_reason = p_note,
           row_version = row_version + 1 WHERE id = p_po;
  ELSE
    RAISE EXCEPTION 'unknown action %', p_action;
  END IF;
END $$;

-- Lines: [{"poLineId": uuid, "qty": n, "batchNo": text?, "expiryDate": date?}, ...]
CREATE FUNCTION inv.po_receive(p_po uuid, p_location uuid, p_invoice_ref text, p_notes text, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_po       purchase_order%ROWTYPE;
  v_pol      purchase_order_line%ROWTYPE;
  v_receipt  uuid;
  v_line     jsonb;
  v_qty      numeric;
  v_move     bigint;
BEGIN
  SELECT * INTO v_po FROM purchase_order WHERE id = p_po AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(v_po.business_unit_id, 'FIN') THEN
    RAISE EXCEPTION 'purchase order not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM inv.po_check(v_po.business_unit_id, 'receive');
  IF v_po.status NOT IN ('approved', 'partially_received') THEN
    RAISE EXCEPTION 'goods can only be received against an approved order' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'enter at least one received line' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO goods_receipt (tenant_id, business_unit_id, receipt_number, purchase_order_id, location_id,
                             supplier_invoice_ref, notes, received_by)
  VALUES (v_po.tenant_id, v_po.business_unit_id, inv.next_doc_number(v_po.business_unit_id, 'GRN'), p_po, p_location,
          nullif(trim(p_invoice_ref), ''), coalesce(p_notes, ''), sec.current_user_id())
  RETURNING id INTO v_receipt;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_qty := (v_line->>'qty')::numeric;
    CONTINUE WHEN v_qty IS NULL OR v_qty = 0;
    SELECT * INTO v_pol FROM purchase_order_line
     WHERE id = (v_line->>'poLineId')::uuid AND purchase_order_id = p_po FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'line is not on this purchase order' USING ERRCODE = 'check_violation'; END IF;
    IF v_qty < 0 OR v_pol.qty_received + v_qty > v_pol.qty_ordered THEN
      RAISE EXCEPTION 'line %: cannot receive % — only % outstanding', v_pol.line_no, trim_scale(v_qty),
        trim_scale(v_pol.qty_ordered - v_pol.qty_received) USING ERRCODE = 'check_violation';
    END IF;

    SELECT id INTO v_move FROM inv.apply_movement(
      v_po.business_unit_id, 'receipt', v_pol.item_id, v_qty, NULL, p_location, NULL,
      nullif(trim(v_line->>'batchNo'), ''), nullif(v_line->>'expiryDate', '')::date, NULL,
      v_pol.unit_cost, NULL, 'goods_receipt', v_receipt::text) AS id;

    INSERT INTO goods_receipt_line (tenant_id, business_unit_id, goods_receipt_id, purchase_order_line_id, item_id,
                                    qty, unit_cost, batch_no, expiry_date, movement_id)
    VALUES (v_po.tenant_id, v_po.business_unit_id, v_receipt, v_pol.id, v_pol.item_id, v_qty, v_pol.unit_cost,
            nullif(trim(v_line->>'batchNo'), ''), nullif(v_line->>'expiryDate', '')::date, v_move);
    UPDATE purchase_order_line SET qty_received = qty_received + v_qty WHERE id = v_pol.id;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM goods_receipt_line WHERE goods_receipt_id = v_receipt) THEN
    RAISE EXCEPTION 'enter at least one received quantity' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE purchase_order
     SET status = CASE WHEN EXISTS (SELECT 1 FROM purchase_order_line WHERE purchase_order_id = p_po AND qty_received < qty_ordered)
                       THEN 'partially_received'::po_status ELSE 'received'::po_status END,
         row_version = row_version + 1
   WHERE id = p_po;
  RETURN v_receipt;
END $$;

-- =====================================================================
-- Inter-unit transfers: the sending unit dispatches (stock leaves at average cost),
-- the receiving unit accepts into a location it chooses, or rejects (sender puts it back).
-- =====================================================================
CREATE TYPE transfer_status AS ENUM ('in_transit', 'received', 'rejected', 'returned');

CREATE TABLE inter_unit_transfer (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  transfer_number        text NOT NULL UNIQUE,
  from_business_unit_id  uuid NOT NULL REFERENCES business_unit(id),
  to_business_unit_id    uuid NOT NULL REFERENCES business_unit(id),
  from_location_id       uuid NOT NULL REFERENCES stock_location(id),
  to_location_id         uuid REFERENCES stock_location(id),
  status                 transfer_status NOT NULL DEFAULT 'in_transit',
  notes                  text NOT NULL DEFAULT '',
  dispatched_by          uuid NOT NULL REFERENCES app_user(id),
  dispatched_at          timestamptz NOT NULL DEFAULT now(),
  received_by            uuid REFERENCES app_user(id),
  received_at            timestamptz,
  rejected_by            uuid REFERENCES app_user(id),
  rejected_at            timestamptz,
  reject_reason          text,
  returned_by            uuid REFERENCES app_user(id),
  returned_at            timestamptz,
  CHECK (from_business_unit_id <> to_business_unit_id)
);

CREATE TABLE inter_unit_transfer_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id     uuid NOT NULL REFERENCES inter_unit_transfer(id),
  item_id         uuid NOT NULL REFERENCES item(id),
  batch_no        text,
  expiry_date     date,
  qty             numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_cost       numeric(14, 4) NOT NULL,
  out_movement_id bigint NOT NULL REFERENCES stock_movement(id)
);

-- Lines: [{"itemId": uuid, "qty": n}, ...]
CREATE FUNCTION inv.transfer_dispatch(p_from_bu uuid, p_to_bu uuid, p_from_location uuid, p_notes text, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id    uuid;
  v_line  jsonb;
  v_item  uuid;
  v_to    business_unit%ROWTYPE;
  v_moves bigint[];
  m       record;
BEGIN
  IF NOT sec.has_scope(p_from_bu, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot send stock from this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_to FROM business_unit WHERE id = p_to_bu AND tenant_id = sec.current_tenant_id() AND is_active;
  IF NOT FOUND OR p_to_bu = p_from_bu THEN
    RAISE EXCEPTION 'choose another business unit to send to' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'a transfer needs at least one line' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO inter_unit_transfer (tenant_id, transfer_number, from_business_unit_id, to_business_unit_id,
                                   from_location_id, notes, dispatched_by)
  VALUES (sec.current_tenant_id(), inv.next_doc_number(p_from_bu, 'TRF'), p_from_bu, p_to_bu, p_from_location,
          coalesce(p_notes, ''), sec.current_user_id())
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_item := (v_line->>'itemId')::uuid;
    IF NOT EXISTS (SELECT 1 FROM business_unit_item WHERE business_unit_id = p_to_bu AND item_id = v_item AND is_active) THEN
      RAISE EXCEPTION '% does not stock this item; ask them to enable it first', v_to.name USING ERRCODE = 'check_violation';
    END IF;
    -- Collect the new movement ids first: a single statement cannot see rows its own function call inserted.
    SELECT array_agg(mv.id) INTO v_moves
      FROM inv.apply_movement(p_from_bu, 'inter_unit_out', v_item, (v_line->>'qty')::numeric, p_from_location, NULL,
                              NULL, NULL, NULL, NULL, NULL, 'to ' || v_to.name, 'inter_unit_transfer', v_id::text) AS mv(id);
    FOR m IN
      SELECT sm.id, sm.qty, sm.unit_cost, b.batch_no, b.expiry_date
        FROM stock_movement sm LEFT JOIN item_batch b ON b.id = sm.batch_id
       WHERE sm.id = ANY (v_moves)
    LOOP
      INSERT INTO inter_unit_transfer_line (transfer_id, item_id, batch_no, expiry_date, qty, unit_cost, out_movement_id)
      VALUES (v_id, v_item, m.batch_no, m.expiry_date, m.qty, coalesce(m.unit_cost, 0), m.id);
    END LOOP;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM inter_unit_transfer_line WHERE transfer_id = v_id) THEN
    RAISE EXCEPTION 'transfer recorded no stock' USING ERRCODE = 'internal_error';
  END IF;
  PERFORM sec.notify_unit(p_to_bu, 'OPS', 'transfer_incoming', 'Stock on its way from ' ||
    (SELECT name FROM business_unit WHERE id = p_from_bu), 'Accept it into one of your stores.', '/transfers');
  RETURN v_id;
END $$;

CREATE FUNCTION inv.transfer_act(p_transfer uuid, p_action text, p_location uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t  inter_unit_transfer%ROWTYPE;
  l  inter_unit_transfer_line%ROWTYPE;
BEGIN
  SELECT * INTO t FROM inter_unit_transfer WHERE id = p_transfer AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer not found' USING ERRCODE = 'no_data_found'; END IF;

  IF p_action IN ('receive', 'reject') THEN
    IF NOT sec.has_scope(t.to_business_unit_id, 'OPS', true) THEN
      RAISE EXCEPTION 'only the receiving unit can do that' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF t.status <> 'in_transit' THEN RAISE EXCEPTION 'this transfer is no longer in transit' USING ERRCODE = 'check_violation'; END IF;
  ELSIF p_action = 'return' THEN
    IF NOT sec.has_scope(t.from_business_unit_id, 'OPS', true) THEN
      RAISE EXCEPTION 'only the sending unit can do that' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF t.status <> 'rejected' THEN RAISE EXCEPTION 'only a rejected transfer can be put back' USING ERRCODE = 'check_violation'; END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inter_unit_transfer_line WHERE transfer_id = p_transfer) THEN
    RAISE EXCEPTION 'transfer has no lines' USING ERRCODE = 'internal_error';
  END IF;

  IF p_action = 'receive' THEN
    FOR l IN SELECT * FROM inter_unit_transfer_line WHERE transfer_id = p_transfer ORDER BY id LOOP
      PERFORM inv.apply_movement(t.to_business_unit_id, 'inter_unit_in', l.item_id, l.qty, NULL, p_location, NULL,
                                 l.batch_no, l.expiry_date, NULL, l.unit_cost,
                                 'from ' || (SELECT name FROM business_unit WHERE id = t.from_business_unit_id),
                                 'inter_unit_transfer', p_transfer::text);
    END LOOP;
    UPDATE inter_unit_transfer SET status = 'received', to_location_id = p_location,
           received_by = sec.current_user_id(), received_at = now() WHERE id = p_transfer;
    PERFORM sec.notify_user(t.dispatched_by, t.from_business_unit_id, 'transfer_received',
                            t.transfer_number || ' received', '', '/transfers');
  ELSIF p_action = 'reject' THEN
    IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'give a reason' USING ERRCODE = 'check_violation'; END IF;
    UPDATE inter_unit_transfer SET status = 'rejected', rejected_by = sec.current_user_id(), rejected_at = now(),
           reject_reason = p_reason WHERE id = p_transfer;
    PERFORM sec.notify_user(t.dispatched_by, t.from_business_unit_id, 'transfer_rejected',
                            t.transfer_number || ' was refused', p_reason, '/transfers');
  ELSIF p_action = 'return' THEN
    FOR l IN SELECT * FROM inter_unit_transfer_line WHERE transfer_id = p_transfer ORDER BY id LOOP
      PERFORM inv.apply_movement(t.from_business_unit_id, 'inter_unit_in', l.item_id, l.qty, NULL, t.from_location_id,
                                 NULL, l.batch_no, l.expiry_date, NULL, l.unit_cost, 'returned: transfer refused',
                                 'inter_unit_transfer', p_transfer::text);
    END LOOP;
    UPDATE inter_unit_transfer SET status = 'returned', returned_by = sec.current_user_id(), returned_at = now()
     WHERE id = p_transfer;
  ELSE
    RAISE EXCEPTION 'unknown action %', p_action;
  END IF;
END $$;

-- =====================================================================
-- Staff item requests: request (anyone working in the unit) → approve (manager) → fulfil (storekeeper)
-- =====================================================================
CREATE TYPE item_request_status AS ENUM ('pending', 'approved', 'rejected', 'fulfilled', 'cancelled');

CREATE TABLE item_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  request_number    text NOT NULL,
  requested_by      uuid NOT NULL REFERENCES app_user(id),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  from_location_id  uuid NOT NULL,
  to_location_id    uuid NOT NULL,
  status            item_request_status NOT NULL DEFAULT 'pending',
  needed_by         date,
  notes             text NOT NULL DEFAULT '',
  decided_by        uuid REFERENCES app_user(id),
  decided_at        timestamptz,
  decision_note     text,
  fulfilled_by      uuid REFERENCES app_user(id),
  fulfilled_at      timestamptz,
  UNIQUE (business_unit_id, request_number),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (from_location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  FOREIGN KEY (to_location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  CHECK (from_location_id <> to_location_id)
);

CREATE TABLE item_request_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_request_id   uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  item_id           uuid NOT NULL REFERENCES item(id),
  qty_requested     numeric(14, 3) NOT NULL CHECK (qty_requested > 0),
  qty_approved      numeric(14, 3) CHECK (qty_approved >= 0),
  FOREIGN KEY (item_request_id, business_unit_id) REFERENCES item_request(id, business_unit_id),
  UNIQUE (item_request_id, item_id)
);

-- Lines: [{"itemId": uuid, "qty": n}, ...]
CREATE FUNCTION inv.request_create(p_bu uuid, p_from uuid, p_to uuid, p_needed_by date, p_notes text, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id   uuid;
  v_line jsonb;
  v_no   text;
BEGIN
  IF NOT sec.has_scope(p_bu, 'OPS') THEN
    RAISE EXCEPTION 'you do not work in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'a request needs at least one item' USING ERRCODE = 'check_violation';
  END IF;
  v_no := inv.next_doc_number(p_bu, 'REQ');
  INSERT INTO item_request (tenant_id, business_unit_id, request_number, requested_by, from_location_id, to_location_id,
                            needed_by, notes)
  VALUES (sec.current_tenant_id(), p_bu, v_no, sec.current_user_id(), p_from, p_to, p_needed_by, coalesce(p_notes, ''))
  RETURNING id INTO v_id;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF NOT EXISTS (SELECT 1 FROM business_unit_item WHERE business_unit_id = p_bu AND item_id = (v_line->>'itemId')::uuid AND is_active) THEN
      RAISE EXCEPTION 'requested item is not stocked in this unit' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO item_request_line (item_request_id, business_unit_id, item_id, qty_requested)
    VALUES (v_id, p_bu, (v_line->>'itemId')::uuid, (v_line->>'qty')::numeric);
  END LOOP;
  PERFORM sec.notify_unit(p_bu, 'CFG', 'request_submitted', v_no || ' needs approval',
                          sec.user_name(sec.current_user_id()) || ' requested items.', '/requests');
  RETURN v_id;
END $$;

-- p_lines (approve only, optional): [{"lineId": uuid, "qtyApproved": n}] — omitted lines are approved in full.
CREATE FUNCTION inv.request_act(p_request uuid, p_action text, p_note text, p_lines jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  q    item_request%ROWTYPE;
  l    item_request_line%ROWTYPE;
  v_me uuid := sec.current_user_id();
BEGIN
  SELECT * INTO q FROM item_request WHERE id = p_request AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(q.business_unit_id, 'OPS') THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_action IN ('approve', 'reject') THEN
    IF NOT sec.has_scope(q.business_unit_id, 'CFG', true) THEN
      RAISE EXCEPTION 'only a manager of this unit can decide requests' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF q.requested_by = v_me AND NOT sec.has_scope(q.business_unit_id, 'FIN', true) THEN
      RAISE EXCEPTION 'you cannot approve your own request' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF q.status <> 'pending' THEN RAISE EXCEPTION 'this request has already been decided' USING ERRCODE = 'check_violation'; END IF;
    IF p_action = 'reject' AND coalesce(trim(p_note), '') = '' THEN
      RAISE EXCEPTION 'give a reason' USING ERRCODE = 'check_violation';
    END IF;
    IF p_action = 'approve' THEN
      UPDATE item_request_line rl SET qty_approved = coalesce(
          (SELECT (x->>'qtyApproved')::numeric FROM jsonb_array_elements(coalesce(p_lines, '[]')) x
            WHERE (x->>'lineId')::uuid = rl.id), rl.qty_requested)
       WHERE rl.item_request_id = p_request;
    END IF;
    UPDATE item_request SET status = CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END::item_request_status,
           decided_by = v_me, decided_at = now(), decision_note = p_note WHERE id = p_request;
    PERFORM sec.notify_user(q.requested_by, q.business_unit_id, 'request_' || p_action || 'd',
                            q.request_number || CASE WHEN p_action = 'approve' THEN ' approved' ELSE ' rejected' END,
                            coalesce(p_note, ''), '/requests');

  ELSIF p_action = 'fulfil' THEN
    IF NOT sec.has_scope(q.business_unit_id, 'OPS', true) THEN
      RAISE EXCEPTION 'you cannot issue stock in this unit' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF q.status <> 'approved' THEN RAISE EXCEPTION 'only approved requests can be fulfilled' USING ERRCODE = 'check_violation'; END IF;
    FOR l IN SELECT * FROM item_request_line WHERE item_request_id = p_request AND qty_approved > 0 ORDER BY id LOOP
      PERFORM inv.apply_movement(q.business_unit_id, 'transfer', l.item_id, l.qty_approved, q.from_location_id,
                                 q.to_location_id, NULL, NULL, NULL, NULL, NULL, q.request_number,
                                 'item_request', p_request::text);
    END LOOP;
    UPDATE item_request SET status = 'fulfilled', fulfilled_by = v_me, fulfilled_at = now() WHERE id = p_request;
    PERFORM sec.notify_user(q.requested_by, q.business_unit_id, 'request_fulfilled', q.request_number || ' is ready',
                            'Items have been moved to your location.', '/requests');

  ELSIF p_action = 'cancel' THEN
    IF q.requested_by <> v_me THEN RAISE EXCEPTION 'only the requester can cancel' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF q.status <> 'pending' THEN RAISE EXCEPTION 'only pending requests can be cancelled' USING ERRCODE = 'check_violation'; END IF;
    UPDATE item_request SET status = 'cancelled' WHERE id = p_request;
  ELSE
    RAISE EXCEPTION 'unknown action %', p_action;
  END IF;
END $$;

-- =====================================================================
-- Audit, row-level security, grants
-- =====================================================================
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON purchase_order      FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON purchase_order_line FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON goods_receipt                           FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT ON goods_receipt_line                      FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON item_request                  FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER UPDATE ON item_cost                               FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

-- Transfers belong to two units; audit them under the sending unit.
CREATE FUNCTION sec.audit_transfer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM sec.audit_append(NEW.tenant_id, NEW.from_business_unit_id, lower(TG_OP), TG_TABLE_NAME, NEW.id::text,
                           CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW));
  RETURN NULL;
END $$;
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON inter_unit_transfer FOR EACH ROW EXECUTE FUNCTION sec.audit_transfer();

ALTER TABLE purchase_order           ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_line      ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt            ENABLE ROW LEVEL SECURITY;
ALTER TABLE goods_receipt_line       ENABLE ROW LEVEL SECURITY;
ALTER TABLE inter_unit_transfer      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inter_unit_transfer_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_request             ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_request_line        ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_sequence             ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_read ON purchase_order FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY pol_read ON purchase_order_line FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY grn_read ON goods_receipt FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY grnl_read ON goods_receipt_line FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY transfer_read ON inter_unit_transfer FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id()
         AND (sec.has_scope(from_business_unit_id, 'OPS') OR sec.has_scope(to_business_unit_id, 'OPS')));
CREATE POLICY transfer_line_read ON inter_unit_transfer_line FOR SELECT TO giddy_app
  USING (EXISTS (SELECT 1 FROM inter_unit_transfer t WHERE t.id = transfer_id));
CREATE POLICY request_read ON item_request FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY request_line_read ON item_request_line FOR SELECT TO giddy_app
  USING (sec.has_scope(business_unit_id, 'OPS'));

-- Documents change only through the inv.* workflow functions.
GRANT SELECT ON purchase_order, purchase_order_line, goods_receipt, goods_receipt_line,
                inter_unit_transfer, inter_unit_transfer_line, item_request, item_request_line TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
REVOKE ALL ON FUNCTION sec.notify_unit(uuid, data_class, text, text, text, text),
                       sec.notify_user(uuid, uuid, text, text, text, text),
                       sec.audit_transfer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  inv.post_movement(uuid, stock_movement_type, uuid, numeric, uuid, uuid, uuid, text, date, date, numeric, text, text, text),
  inv.po_save_draft(uuid, uuid, uuid, date, text, jsonb),
  inv.po_transition(uuid, text, text),
  inv.po_receive(uuid, uuid, text, text, jsonb),
  inv.transfer_dispatch(uuid, uuid, uuid, text, jsonb),
  inv.transfer_act(uuid, text, uuid, text),
  inv.request_create(uuid, uuid, uuid, date, text, jsonb),
  inv.request_act(uuid, text, text, jsonb)
TO giddy_app;
