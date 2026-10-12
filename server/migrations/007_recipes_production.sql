-- =====================================================================
-- 007 Recipes (bills of materials) and production orders
--   * Selling a menu item that has a recipe deducts its ingredients.
--   * Production orders batch-prepare stock items ahead of service,
--     with yield variance (planned vs actual output).
-- =====================================================================

ALTER TYPE stock_movement_type ADD VALUE 'production_consume';
ALTER TYPE stock_movement_type ADD VALUE 'production_output';

CREATE OR REPLACE FUNCTION inv.movement_direction(p_type stock_movement_type) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type::text
    WHEN 'opening_balance' THEN 'in' WHEN 'adjustment_in' THEN 'in' WHEN 'receipt' THEN 'in' WHEN 'inter_unit_in' THEN 'in'
    WHEN 'sale_void' THEN 'in' WHEN 'production_output' THEN 'in'
    WHEN 'adjustment_out' THEN 'out' WHEN 'issue' THEN 'out' WHEN 'wastage' THEN 'out' WHEN 'inter_unit_out' THEN 'out'
    WHEN 'sale' THEN 'out' WHEN 'production_consume' THEN 'out'
    WHEN 'transfer' THEN 'move'
  END
$$;

-- =====================================================================
-- Ledger: a work-in-progress account, and a table-driven movement → accounts map
-- (so later movement types add a row instead of rewriting the trigger).
-- =====================================================================
CREATE OR REPLACE FUNCTION fin.ensure_chart(p_bu uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO ledger_account (tenant_id, business_unit_id, code, name, account_type, is_system)
  SELECT bu.tenant_id, bu.id, a.code, a.name, a.t::account_type, true
    FROM business_unit bu,
         (VALUES ('1000', 'Cash on hand', 'asset'), ('1010', 'Card / POS clearing', 'asset'),
                 ('1020', 'Bank', 'asset'), ('1150', 'Due from other units', 'asset'),
                 ('1200', 'Inventory', 'asset'), ('1250', 'Production in progress', 'asset'),
                 ('2000', 'Accounts payable (suppliers)', 'liability'), ('2100', 'VAT payable', 'liability'),
                 ('2200', 'Due to other units', 'liability'),
                 ('3000', 'Opening balance equity', 'equity'),
                 ('4000', 'Sales revenue', 'revenue'), ('4100', 'Service charge income', 'revenue'),
                 ('5000', 'Cost of goods sold', 'expense'), ('5100', 'Stock write-offs (wastage)', 'expense'),
                 ('5200', 'Stock adjustments', 'expense'), ('5300', 'Stock used internally', 'expense')) AS a(code, name, t)
   WHERE bu.id = p_bu
  ON CONFLICT (business_unit_id, code) DO NOTHING
$$;
SELECT fin.ensure_chart(id) FROM business_unit;

CREATE TABLE fin.movement_account (
  movement_type  text PRIMARY KEY,
  debit_code     text NOT NULL,
  credit_code    text NOT NULL
);
INSERT INTO fin.movement_account VALUES
  ('opening_balance', '1200', '3000'), ('receipt', '1200', '2000'),
  ('adjustment_in', '1200', '5200'), ('adjustment_out', '5200', '1200'),
  ('wastage', '5100', '1200'), ('issue', '5300', '1200'),
  ('sale', '5000', '1200'), ('sale_void', '1200', '5000'),
  ('production_consume', '1250', '1200'), ('production_output', '1200', '1250');

CREATE OR REPLACE FUNCTION fin.journal_for_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_amount numeric := round(NEW.qty * coalesce(NEW.unit_cost, 0), 2);
  v_dr text; v_cr text; v_cp uuid;
  t inter_unit_transfer%ROWTYPE;
BEGIN
  IF v_amount = 0 OR NEW.movement_type = 'transfer' THEN RETURN NULL; END IF;
  IF NEW.movement_type IN ('inter_unit_out', 'inter_unit_in') THEN
    SELECT * INTO t FROM inter_unit_transfer WHERE id = NEW.source_doc_id::uuid;
    IF NEW.movement_type = 'inter_unit_out' THEN
      v_dr := '1150'; v_cr := '1200'; v_cp := t.to_business_unit_id;
    ELSIF NEW.business_unit_id = t.to_business_unit_id THEN
      v_dr := '1200'; v_cr := '2200'; v_cp := t.from_business_unit_id;   -- received: we owe the sender
    ELSE
      v_dr := '1200'; v_cr := '1150'; v_cp := t.to_business_unit_id;     -- refused and put back: claim cancelled
    END IF;
  ELSE
    SELECT debit_code, credit_code INTO v_dr, v_cr FROM fin.movement_account WHERE movement_type = NEW.movement_type::text;
    IF v_dr IS NULL THEN RETURN NULL; END IF;
  END IF;
  PERFORM fin.post_entry(NEW.business_unit_id, NEW.posted_at::date, 'stock_movement', NEW.id::text,
    replace(NEW.movement_type::text, '_', ' '),
    jsonb_build_array(jsonb_build_object('code', v_dr, 'debit', v_amount, 'counterparty', CASE WHEN v_dr IN ('1150', '2200') THEN v_cp END),
                      jsonb_build_object('code', v_cr, 'credit', v_amount, 'counterparty', CASE WHEN v_cr IN ('1150', '2200') THEN v_cp END)));
  RETURN NULL;
END $$;

-- =====================================================================
-- Recipes: an output item made from ingredients. "yield_qty" units of output
-- need the listed ingredient quantities (in each ingredient's base unit).
-- =====================================================================
CREATE TABLE recipe (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  output_item_id    uuid NOT NULL,
  yield_qty         numeric(14, 3) NOT NULL DEFAULT 1 CHECK (yield_qty > 0),
  notes             text NOT NULL DEFAULT '',
  is_active         boolean NOT NULL DEFAULT true,
  updated_by        uuid REFERENCES app_user(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  UNIQUE (business_unit_id, output_item_id),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (output_item_id, tenant_id) REFERENCES item(id, tenant_id)
);

CREATE TABLE recipe_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  recipe_id         uuid NOT NULL,
  item_id           uuid NOT NULL,
  qty               numeric(14, 4) NOT NULL CHECK (qty > 0),
  UNIQUE (recipe_id, item_id),
  FOREIGN KEY (recipe_id, business_unit_id) REFERENCES recipe(id, business_unit_id) ON DELETE CASCADE,
  FOREIGN KEY (item_id, tenant_id) REFERENCES item(id, tenant_id)
);

-- Lines: [{"itemId": uuid, "qty": n}]. Managers (CFG write) maintain recipes.
CREATE FUNCTION inv.recipe_save(p_bu uuid, p_output_item uuid, p_yield numeric, p_notes text, p_active boolean, p_lines jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id   uuid;
  v_line jsonb;
  v_item record;
BEGIN
  IF NOT sec.has_scope(p_bu, 'CFG', true) THEN
    RAISE EXCEPTION 'only a manager of this unit can change recipes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_unit_item WHERE business_unit_id = p_bu AND item_id = p_output_item AND is_active) THEN
    RAISE EXCEPTION 'the dish or drink must be enabled in this unit first' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'a recipe needs at least one ingredient' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO recipe (tenant_id, business_unit_id, output_item_id, yield_qty, notes, is_active, updated_by)
  VALUES (sec.current_tenant_id(), p_bu, p_output_item, coalesce(p_yield, 1), coalesce(p_notes, ''), coalesce(p_active, true),
          sec.current_user_id())
  ON CONFLICT (business_unit_id, output_item_id) DO UPDATE
    SET yield_qty = EXCLUDED.yield_qty, notes = EXCLUDED.notes, is_active = EXCLUDED.is_active,
        updated_by = EXCLUDED.updated_by, updated_at = now(), row_version = recipe.row_version + 1
  RETURNING id INTO v_id;

  DELETE FROM recipe_line WHERE recipe_id = v_id;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT i.id, i.name, i.is_stockable INTO v_item FROM item i
      JOIN business_unit_item bui ON bui.item_id = i.id AND bui.business_unit_id = p_bu AND bui.is_active
     WHERE i.id = (v_line->>'itemId')::uuid AND i.is_active;
    IF NOT FOUND OR NOT v_item.is_stockable THEN
      RAISE EXCEPTION 'every ingredient must be a stock item enabled in this unit' USING ERRCODE = 'check_violation';
    END IF;
    IF v_item.id = p_output_item THEN
      RAISE EXCEPTION 'a recipe cannot use its own output as an ingredient' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO recipe_line (tenant_id, business_unit_id, recipe_id, item_id, qty)
    VALUES (sec.current_tenant_id(), p_bu, v_id, v_item.id, (v_line->>'qty')::numeric);
  END LOOP;
  RETURN v_id;
END $$;

-- =====================================================================
-- Selling: what stock does one ticket line use?
--   stock item              → the item itself, from the till's store
--   non-stock item + recipe → its ingredients (qty × line ÷ yield), from the till's store
--   non-stock item, no recipe (a service, corkage) → nothing
-- =====================================================================
CREATE FUNCTION pos.stock_for_sale(p_bu uuid, p_item uuid, p_qty numeric, p_location uuid, p_ticket_no text, p_ticket uuid,
                                   OUT movement_ids bigint[], OUT cost numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item  item%ROWTYPE;
  v_rec   recipe%ROWTYPE;
  l       recipe_line%ROWTYPE;
  v_moves bigint[];
BEGIN
  movement_ids := '{}';
  cost := 0;
  SELECT * INTO v_item FROM item WHERE id = p_item;
  IF v_item.is_stockable THEN
    IF p_location IS NULL THEN RAISE EXCEPTION 'choose the store this till sells from' USING ERRCODE = 'check_violation'; END IF;
    SELECT array_agg(mv.id) INTO movement_ids
      FROM inv.apply_movement(p_bu, 'sale', p_item, p_qty, p_location, NULL, NULL, NULL, NULL, NULL, NULL,
                              p_ticket_no, 'sale_ticket', p_ticket::text) AS mv(id);
  ELSE
    SELECT * INTO v_rec FROM recipe WHERE business_unit_id = p_bu AND output_item_id = p_item AND is_active;
    IF FOUND THEN
      IF p_location IS NULL THEN RAISE EXCEPTION 'choose the store this till sells from' USING ERRCODE = 'check_violation'; END IF;
      FOR l IN SELECT * FROM recipe_line WHERE recipe_id = v_rec.id ORDER BY item_id LOOP
        SELECT array_agg(mv.id) INTO v_moves
          FROM inv.apply_movement(p_bu, 'sale', l.item_id, round(l.qty * p_qty / v_rec.yield_qty, 3), p_location, NULL,
                                  NULL, NULL, NULL, NULL, NULL, p_ticket_no || ' · ' || v_item.name, 'sale_ticket', p_ticket::text) AS mv(id);
        movement_ids := movement_ids || v_moves;
      END LOOP;
    END IF;
  END IF;
  SELECT coalesce(sum(round(qty * coalesce(unit_cost, 0), 2)), 0) INTO cost FROM stock_movement WHERE id = ANY (movement_ids);
END $$;

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

-- =====================================================================
-- Production orders: planned → completed (or cancelled)
-- =====================================================================
CREATE TYPE production_status AS ENUM ('planned', 'completed', 'cancelled');

CREATE TABLE production_order (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  business_unit_id    uuid NOT NULL,
  order_number        text NOT NULL,
  recipe_id           uuid NOT NULL,
  output_item_id      uuid NOT NULL REFERENCES item(id),
  planned_output_qty  numeric(14, 3) NOT NULL CHECK (planned_output_qty > 0),
  actual_output_qty   numeric(14, 3) CHECK (actual_output_qty >= 0),
  from_location_id    uuid NOT NULL,
  to_location_id      uuid NOT NULL,
  status              production_status NOT NULL DEFAULT 'planned',
  planned_for         date,
  notes               text NOT NULL DEFAULT '',
  input_cost          numeric(16, 2),
  output_unit_cost    numeric(14, 4),
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_by        uuid REFERENCES app_user(id),
  completed_at        timestamptz,
  cancelled_by        uuid REFERENCES app_user(id),
  cancelled_at        timestamptz,
  UNIQUE (business_unit_id, order_number),
  UNIQUE (id, business_unit_id),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  FOREIGN KEY (recipe_id, business_unit_id) REFERENCES recipe(id, business_unit_id),
  FOREIGN KEY (from_location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id),
  FOREIGN KEY (to_location_id, business_unit_id) REFERENCES stock_location(id, business_unit_id)
);
CREATE INDEX ON production_order (business_unit_id, created_at DESC);

CREATE TABLE production_order_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id uuid NOT NULL,
  business_unit_id    uuid NOT NULL,
  item_id             uuid NOT NULL REFERENCES item(id),
  planned_qty         numeric(14, 3) NOT NULL CHECK (planned_qty > 0),
  actual_qty          numeric(14, 3) CHECK (actual_qty >= 0),
  cost_amount         numeric(16, 2),
  FOREIGN KEY (production_order_id, business_unit_id) REFERENCES production_order(id, business_unit_id),
  UNIQUE (production_order_id, item_id)
);

CREATE FUNCTION inv.production_create(p_bu uuid, p_recipe uuid, p_planned numeric, p_from uuid, p_to uuid,
                                      p_planned_for date, p_notes text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rec  recipe%ROWTYPE;
  v_out  item%ROWTYPE;
  v_id   uuid;
BEGIN
  IF NOT sec.has_scope(p_bu, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot plan production in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_rec FROM recipe WHERE id = p_recipe AND business_unit_id = p_bu AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'recipe not found' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_out FROM item WHERE id = v_rec.output_item_id;
  IF NOT v_out.is_stockable THEN
    RAISE EXCEPTION '% is made to order, not kept in stock; production orders are for stock items', v_out.name
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_planned IS NULL OR p_planned <= 0 THEN RAISE EXCEPTION 'planned quantity must be above zero' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_location WHERE id = p_from AND business_unit_id = p_bu AND is_active)
     OR NOT EXISTS (SELECT 1 FROM stock_location WHERE id = p_to AND business_unit_id = p_bu AND is_active) THEN
    RAISE EXCEPTION 'choose active stores of this unit' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO production_order (tenant_id, business_unit_id, order_number, recipe_id, output_item_id, planned_output_qty,
                                from_location_id, to_location_id, planned_for, notes, created_by)
  VALUES (sec.current_tenant_id(), p_bu, inv.next_doc_number(p_bu, 'PRD'), p_recipe, v_rec.output_item_id, p_planned,
          p_from, p_to, p_planned_for, coalesce(p_notes, ''), sec.current_user_id())
  RETURNING id INTO v_id;
  INSERT INTO production_order_line (production_order_id, business_unit_id, item_id, planned_qty)
  SELECT v_id, p_bu, item_id, round(qty * p_planned / v_rec.yield_qty, 3) FROM recipe_line WHERE recipe_id = p_recipe;
  RETURN v_id;
END $$;

-- Completing consumes the ingredients actually used (default: planned) from the "from" store and
-- puts the actual output into the "to" store, costed at total ingredient cost ÷ actual output.
-- p_lines (optional): [{"lineId": uuid, "actualQty": n}]
CREATE FUNCTION inv.production_complete(p_order uuid, p_actual_output numeric, p_expiry date, p_lines jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o        production_order%ROWTYPE;
  l        production_order_line%ROWTYPE;
  v_actual numeric;
  v_moves  bigint[];
  v_cost   numeric;
  v_total  numeric := 0;
  v_unit   numeric;
  v_out_id bigint;
  v_outval numeric;
  v_batch  boolean;
BEGIN
  SELECT * INTO o FROM production_order WHERE id = p_order AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(o.business_unit_id, 'OPS') THEN
    RAISE EXCEPTION 'production order not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT sec.has_scope(o.business_unit_id, 'OPS', true) THEN
    RAISE EXCEPTION 'you cannot record production in this unit' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF o.status <> 'planned' THEN RAISE EXCEPTION 'this order is already %', o.status USING ERRCODE = 'check_violation'; END IF;
  IF p_actual_output IS NULL OR p_actual_output < 0 THEN
    RAISE EXCEPTION 'enter the quantity actually produced' USING ERRCODE = 'check_violation';
  END IF;

  FOR l IN SELECT * FROM production_order_line WHERE production_order_id = p_order ORDER BY item_id LOOP
    v_actual := coalesce((SELECT (x->>'actualQty')::numeric FROM jsonb_array_elements(coalesce(p_lines, '[]')) x
                           WHERE (x->>'lineId')::uuid = l.id), l.planned_qty);
    v_cost := 0;
    IF v_actual > 0 THEN
      SELECT array_agg(mv.id) INTO v_moves
        FROM inv.apply_movement(o.business_unit_id, 'production_consume', l.item_id, v_actual, o.from_location_id, NULL,
                                NULL, NULL, NULL, NULL, NULL, o.order_number, 'production_order', p_order::text) AS mv(id);
      SELECT coalesce(sum(round(qty * coalesce(unit_cost, 0), 2)), 0) INTO v_cost FROM stock_movement WHERE id = ANY (v_moves);
    END IF;
    UPDATE production_order_line SET actual_qty = v_actual, cost_amount = v_cost WHERE id = l.id;
    v_total := v_total + v_cost;
  END LOOP;

  IF p_actual_output > 0 THEN
    v_unit := round(v_total / p_actual_output, 4);
    SELECT is_batch_tracked INTO v_batch FROM item WHERE id = o.output_item_id;
    SELECT mv.id INTO v_out_id
      FROM inv.apply_movement(o.business_unit_id, 'production_output', o.output_item_id, p_actual_output, NULL, o.to_location_id,
                              NULL, CASE WHEN v_batch THEN o.order_number END, p_expiry, CASE WHEN v_batch THEN current_date END,
                              v_unit, NULL, 'production_order', p_order::text) AS mv(id);
    v_outval := round(p_actual_output * v_unit, 2);
  ELSE
    v_unit := NULL;
    v_outval := 0;
  END IF;

  -- Whatever is left in production-in-progress (a failed batch, or rounding) is written off.
  PERFORM fin.post_entry(o.business_unit_id, current_date, 'production_order', p_order::text,
    o.order_number || ' production loss / rounding',
    jsonb_build_array(jsonb_build_object('code', '5100', 'debit', greatest(v_total - v_outval, 0)),
                      jsonb_build_object('code', '5200', 'credit', greatest(v_outval - v_total, 0)),
                      jsonb_build_object('code', '1250', 'credit', greatest(v_total - v_outval, 0)),
                      jsonb_build_object('code', '1250', 'debit', greatest(v_outval - v_total, 0))));

  UPDATE production_order SET status = 'completed', actual_output_qty = p_actual_output, input_cost = v_total,
         output_unit_cost = v_unit, completed_by = sec.current_user_id(), completed_at = now()
   WHERE id = p_order;
END $$;

CREATE FUNCTION inv.production_cancel(p_order uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o production_order%ROWTYPE;
BEGIN
  SELECT * INTO o FROM production_order WHERE id = p_order AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT sec.has_scope(o.business_unit_id, 'OPS', true) THEN
    RAISE EXCEPTION 'production order not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF o.status <> 'planned' THEN RAISE EXCEPTION 'only planned orders can be cancelled' USING ERRCODE = 'check_violation'; END IF;
  UPDATE production_order SET status = 'cancelled', cancelled_by = sec.current_user_id(), cancelled_at = now() WHERE id = p_order;
END $$;

-- =====================================================================
-- Audit, row-level security, grants
-- =====================================================================
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON recipe     FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR DELETE ON recipe_line          FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON production_order     FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

ALTER TABLE recipe                ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_line           ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order      ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_line ENABLE ROW LEVEL SECURITY;

-- Recipes are configuration but the kitchen needs to read them: OPS or CFG read.
CREATE POLICY recipe_read ON recipe FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY recipe_line_read ON recipe_line FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND (sec.has_scope(business_unit_id, 'OPS') OR sec.has_scope(business_unit_id, 'CFG')));
CREATE POLICY production_read ON production_order FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'OPS'));
CREATE POLICY production_line_read ON production_order_line FOR SELECT TO giddy_app
  USING (sec.has_scope(business_unit_id, 'OPS'));

GRANT SELECT ON recipe, recipe_line, production_order, production_order_line TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pos FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fin FROM PUBLIC;
REVOKE ALL ON fin.movement_account FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  inv.recipe_save(uuid, uuid, numeric, text, boolean, jsonb),
  inv.production_create(uuid, uuid, numeric, uuid, uuid, date, text),
  inv.production_complete(uuid, numeric, date, jsonb),
  inv.production_cancel(uuid)
TO giddy_app;
