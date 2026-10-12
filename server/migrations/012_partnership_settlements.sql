-- =====================================================================
-- 012 Partnership settlements (the Spa).
--
-- The revenue-share terms are an agreement between two sides, the Owner and the
-- unit's partner: one proposes, the other accepts. Every term may be left blank
-- until it is known; a statement cannot be issued while any is blank.
--
--   rate_pct        the share, as a percentage of the base
--   beneficiary     who receives rate_pct of the base (owner or partner)
--   basis           gross (with service charge and VAT) | net_of_vat | net (without both)
--   collector       who collects the clients' payments (owner or partner)
--   include_retail  whether product (stock item) sales count, or only services
--
-- Monthly statement: base from the unit's books for the month; share = base × rate.
--   collector ≠ beneficiary → the collector pays the beneficiary the share
--   collector = beneficiary → the beneficiary pays the other side the rest (base − share)
-- Lifecycle: issued (by one side, figures frozen) → agreed (other side; accrued in the
-- unit's books) → paid (posted in the unit's books). The issuer may withdraw before agreement.
-- =====================================================================

CREATE SCHEMA pt;
REVOKE ALL ON SCHEMA pt FROM PUBLIC;
GRANT USAGE ON SCHEMA pt TO giddy_app;

CREATE OR REPLACE FUNCTION fin.ensure_chart(p_bu uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO ledger_account (tenant_id, business_unit_id, code, name, account_type, is_system)
  SELECT bu.tenant_id, bu.id, a.code, a.name, a.t::account_type, true
    FROM business_unit bu,
         (VALUES ('1000', 'Cash on hand', 'asset'), ('1010', 'Card / POS clearing', 'asset'),
                 ('1020', 'Bank', 'asset'), ('1100', 'Guest & client ledger (open bills)', 'asset'),
                 ('1150', 'Due from other units', 'asset'), ('1160', 'Due from owner (revenue share)', 'asset'),
                 ('1200', 'Inventory', 'asset'), ('1250', 'Production in progress', 'asset'),
                 ('2000', 'Accounts payable (suppliers)', 'liability'), ('2100', 'VAT payable', 'liability'),
                 ('2200', 'Due to other units', 'liability'), ('2300', 'Due to owner (revenue share)', 'liability'),
                 ('3000', 'Opening balance equity', 'equity'),
                 ('4000', 'Sales revenue', 'revenue'), ('4100', 'Service charge income', 'revenue'),
                 ('4200', 'Room revenue', 'revenue'), ('4300', 'Bookings revenue', 'revenue'),
                 ('4400', 'Revenue share earned', 'revenue'),
                 ('5000', 'Cost of goods sold', 'expense'), ('5100', 'Stock write-offs (wastage)', 'expense'),
                 ('5200', 'Stock adjustments', 'expense'), ('5300', 'Stock used internally', 'expense'),
                 ('5400', 'Revenue share paid', 'expense')) AS a(code, name, t)
   WHERE bu.id = p_bu
  ON CONFLICT (business_unit_id, code) DO NOTHING
$$;
SELECT fin.ensure_chart(id) FROM business_unit;

CREATE TYPE share_side AS ENUM ('owner', 'partner');
CREATE TYPE share_basis AS ENUM ('gross', 'net_of_vat', 'net');
CREATE TYPE agreement_status AS ENUM ('proposed', 'agreed', 'rejected', 'withdrawn');
CREATE TYPE statement_status AS ENUM ('issued', 'agreed', 'paid', 'withdrawn');

CREATE TABLE partnership_agreement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  version           integer NOT NULL,
  status            agreement_status NOT NULL DEFAULT 'proposed',
  rate_pct          numeric(5, 2) CHECK (rate_pct BETWEEN 0 AND 100),
  beneficiary       share_side,
  basis             share_basis,
  collector         share_side,
  include_retail    boolean,
  effective_from    date NOT NULL,
  notes             text NOT NULL DEFAULT '',
  proposed_side     share_side NOT NULL,
  proposed_by       uuid NOT NULL REFERENCES app_user(id),
  proposed_at       timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid REFERENCES app_user(id),
  decided_at        timestamptz,
  decision_note     text,
  UNIQUE (business_unit_id, version),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id)
);
CREATE UNIQUE INDEX one_open_proposal ON partnership_agreement (business_unit_id) WHERE status = 'proposed';

CREATE TABLE settlement_statement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  business_unit_id  uuid NOT NULL,
  statement_number  text NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,              -- exclusive
  agreement_id      uuid NOT NULL REFERENCES partnership_agreement(id),
  figures           jsonb NOT NULL,             -- frozen at issue: revenue, service charge, VAT, retail, base, share
  base              numeric(16, 2) NOT NULL,
  share             numeric(16, 2) NOT NULL,
  payer             share_side NOT NULL,
  payee             share_side NOT NULL,
  amount            numeric(16, 2) NOT NULL CHECK (amount >= 0),
  status            statement_status NOT NULL DEFAULT 'issued',
  issued_side       share_side NOT NULL,
  issued_by         uuid NOT NULL REFERENCES app_user(id),
  issued_at         timestamptz NOT NULL DEFAULT now(),
  agreed_by         uuid REFERENCES app_user(id),
  agreed_at         timestamptz,
  paid_by           uuid REFERENCES app_user(id),
  paid_at           timestamptz,
  payment_method    payment_method,
  payment_reference text,
  withdrawn_by      uuid REFERENCES app_user(id),
  withdrawn_at      timestamptz,
  accrual_entry_id  bigint REFERENCES journal_entry(id),
  payment_entry_id  bigint REFERENCES journal_entry(id),
  UNIQUE (business_unit_id, statement_number),
  FOREIGN KEY (business_unit_id, tenant_id) REFERENCES business_unit(id, tenant_id),
  CHECK (payer <> payee),
  CHECK (period_end > period_start)
);
CREATE UNIQUE INDEX one_statement_per_period ON settlement_statement (business_unit_id, period_start) WHERE status <> 'withdrawn';

-- =====================================================================
-- Sides
-- =====================================================================
-- Which side of the unit's partnership the current user speaks for, if any.
CREATE FUNCTION pt.side(p_bu uuid) RETURNS share_side
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN (SELECT management_model FROM business_unit WHERE id = p_bu AND tenant_id = sec.current_tenant_id()) <> 'partnership' THEN NULL
              WHEN sec.has_perm('tenant.settings') THEN 'owner'::share_side
              WHEN sec.has_perm('grants.approve', p_bu) THEN 'partner'::share_side END
$$;

CREATE FUNCTION pt.can_view(p_bu uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pt.side(p_bu) IS NOT NULL OR sec.has_scope(p_bu, 'FIN')
$$;

CREATE FUNCTION pt.require_side(p_bu uuid) RETURNS share_side
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v share_side;
BEGIN
  IF (SELECT management_model FROM business_unit WHERE id = p_bu AND tenant_id = sec.current_tenant_id()) IS DISTINCT FROM 'partnership' THEN
    RAISE EXCEPTION 'settlements are for partnership-managed units' USING ERRCODE = 'check_violation';
  END IF;
  v := pt.side(p_bu);
  IF v IS NULL THEN
    RAISE EXCEPTION 'only the Owner or the unit''s partner can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v;
END $$;

-- Notifies the people who speak for one side.
CREATE FUNCTION pt.notify_side(p_bu uuid, p_side share_side, p_title text, p_body text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT sec.notify_user(u, p_bu, 'settlement', p_title, p_body, '/partnership')
    FROM (SELECT DISTINCT a.user_id AS u FROM user_role_assignment a
            JOIN role_permission rp ON rp.role_id = a.role_id
           WHERE a.tenant_id = sec.current_tenant_id() AND a.status = 'active'
             AND ((p_side = 'owner' AND rp.permission_code = 'tenant.settings' AND a.business_unit_id IS NULL)
               OR (p_side = 'partner' AND rp.permission_code = 'grants.approve' AND a.business_unit_id = p_bu))) x
$$;

CREATE FUNCTION pt.other(p share_side) RETURNS share_side
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p WHEN 'owner' THEN 'partner'::share_side ELSE 'owner'::share_side END $$;

-- =====================================================================
-- Agreement
-- =====================================================================
-- p_terms: {"ratePct", "beneficiary", "basis", "collector", "includeRetail"} — any may be null (not yet known).
CREATE FUNCTION pt.propose(p_bu uuid, p_terms jsonb, p_effective_from date, p_notes text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_side share_side; v_id uuid; v_version integer;
BEGIN
  v_side := pt.require_side(p_bu);
  IF EXISTS (SELECT 1 FROM partnership_agreement WHERE business_unit_id = p_bu AND status = 'proposed') THEN
    RAISE EXCEPTION 'a proposal is already waiting for a decision' USING ERRCODE = 'GD409';
  END IF;
  IF p_effective_from IS NULL THEN RAISE EXCEPTION 'choose the date the terms apply from' USING ERRCODE = 'check_violation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('agreement:' || p_bu, 0));
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM partnership_agreement WHERE business_unit_id = p_bu;
  INSERT INTO partnership_agreement (tenant_id, business_unit_id, version, rate_pct, beneficiary, basis, collector, include_retail,
                                     effective_from, notes, proposed_side, proposed_by)
  VALUES (sec.current_tenant_id(), p_bu, v_version, (p_terms ->> 'ratePct')::numeric, (p_terms ->> 'beneficiary')::share_side,
          (p_terms ->> 'basis')::share_basis, (p_terms ->> 'collector')::share_side, (p_terms ->> 'includeRetail')::boolean,
          date_trunc('month', p_effective_from)::date, coalesce(p_notes, ''), v_side, sec.current_user_id())
  RETURNING id INTO v_id;
  PERFORM pt.notify_side(p_bu, pt.other(v_side), 'Revenue-share terms proposed',
    format('Version %s, from %s. Please review and accept or reject.', v_version, to_char(date_trunc('month', p_effective_from), 'Mon YYYY')));
  RETURN v_id;
END $$;

CREATE FUNCTION pt.decide(p_agreement uuid, p_accept boolean, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g partnership_agreement%ROWTYPE; v_side share_side;
BEGIN
  SELECT * INTO g FROM partnership_agreement WHERE id = p_agreement AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT pt.can_view(g.business_unit_id) THEN RAISE EXCEPTION 'agreement not found' USING ERRCODE = 'no_data_found'; END IF;
  v_side := pt.require_side(g.business_unit_id);
  IF g.status <> 'proposed' THEN RAISE EXCEPTION 'this proposal was already decided' USING ERRCODE = 'check_violation'; END IF;
  IF v_side = g.proposed_side THEN
    RAISE EXCEPTION 'the other side must accept or reject this proposal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT p_accept AND coalesce(trim(p_note), '') = '' THEN
    RAISE EXCEPTION 'say why the proposal is rejected' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE partnership_agreement SET status = CASE WHEN p_accept THEN 'agreed'::agreement_status ELSE 'rejected' END,
         decided_by = sec.current_user_id(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '')
   WHERE id = g.id;
  PERFORM pt.notify_side(g.business_unit_id, g.proposed_side,
    CASE WHEN p_accept THEN 'Revenue-share terms agreed' ELSE 'Revenue-share terms rejected' END,
    format('Version %s%s', g.version, CASE WHEN p_note IS NOT NULL AND trim(p_note) <> '' THEN ': ' || trim(p_note) ELSE '' END));
END $$;

CREATE FUNCTION pt.withdraw_proposal(p_agreement uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g partnership_agreement%ROWTYPE;
BEGIN
  SELECT * INTO g FROM partnership_agreement WHERE id = p_agreement AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT pt.can_view(g.business_unit_id) THEN RAISE EXCEPTION 'agreement not found' USING ERRCODE = 'no_data_found'; END IF;
  IF pt.require_side(g.business_unit_id) <> g.proposed_side THEN
    RAISE EXCEPTION 'only the side that proposed it can withdraw it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF g.status <> 'proposed' THEN RAISE EXCEPTION 'this proposal was already decided' USING ERRCODE = 'check_violation'; END IF;
  UPDATE partnership_agreement SET status = 'withdrawn', decided_by = sec.current_user_id(), decided_at = now() WHERE id = g.id;
END $$;

-- The agreed terms in force on a date: the latest agreed version effective by then.
CREATE FUNCTION pt.terms_on(p_bu uuid, p_date date) RETURNS partnership_agreement
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM partnership_agreement
   WHERE business_unit_id = p_bu AND status = 'agreed' AND effective_from <= p_date
   ORDER BY effective_from DESC, version DESC LIMIT 1
$$;

-- =====================================================================
-- Figures and statements
-- =====================================================================
-- Revenue for [p_from, p_to) from the unit's books, with the retail (stock item) part separated.
CREATE FUNCTION pt.figures(p_bu uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH je AS (
    SELECT id FROM journal_entry WHERE business_unit_id = p_bu AND entry_date >= p_from AND entry_date < p_to
  ), led AS (
    SELECT a.code, sum(l.credit - l.debit) AS amt
      FROM journal_line l JOIN ledger_account a ON a.id = l.account_id
     WHERE l.journal_entry_id IN (SELECT id FROM je) AND a.code IN ('4000', '4200', '4300', '4100', '2100')
     GROUP BY a.code
  ), till AS (            -- product lines on till tickets: sales in the period, less voids in the period
    SELECT sum(sgn * r.net) AS net, sum(sgn * r.svc) AS svc, sum(sgn * r.vat) AS vat
      FROM (SELECT t.*, 1 AS sgn FROM sale_ticket t WHERE t.business_unit_id = p_bu AND t.journal_entry_id IN (SELECT id FROM je)
            UNION ALL
            SELECT t.*, -1 FROM sale_ticket t WHERE t.business_unit_id = p_bu AND t.void_journal_entry_id IN (SELECT id FROM je)) t
      CROSS JOIN LATERAL (
        SELECT n AS net, round(n * t.service_charge_pct / 100, 2) AS svc,
               round((n + round(n * t.service_charge_pct / 100, 2)) * t.tax_pct / 100, 2) AS vat
          FROM (SELECT round(coalesce(sum(sl.line_total), 0) * (1 - t.discount_pct / 100), 2) AS n
                  FROM sale_line sl JOIN item i ON i.id = sl.item_id
                 WHERE sl.sale_ticket_id = t.id AND i.is_stockable) x) r
  ), bills AS (           -- product add-ons on appointment bills (and their removals)
    SELECT sum(CASE WHEN be.entry_type = 'addon' THEN be.amount ELSE 0 END) AS net,
           sum(CASE WHEN be.entry_type = 'service_charge' THEN be.amount ELSE 0 END) AS svc,
           sum(CASE WHEN be.entry_type = 'tax' THEN be.amount ELSE 0 END) AS vat
      FROM bill_entry be
     WHERE be.business_unit_id = p_bu AND be.journal_entry_id IN (SELECT id FROM je)
       AND be.journal_entry_id IN (SELECT x.journal_entry_id FROM bill_entry x JOIN item i ON i.id = x.item_id
                                    WHERE x.entry_type = 'addon' AND i.is_stockable)
  )
  SELECT jsonb_build_object(
    'net', coalesce((SELECT sum(amt) FROM led WHERE code IN ('4000', '4200', '4300')), 0),
    'serviceCharge', coalesce((SELECT amt FROM led WHERE code = '4100'), 0),
    'vat', coalesce((SELECT amt FROM led WHERE code = '2100'), 0),
    'retailNet', coalesce((SELECT net FROM till), 0) + coalesce((SELECT net FROM bills), 0),
    'retailServiceCharge', coalesce((SELECT svc FROM till), 0) + coalesce((SELECT svc FROM bills), 0),
    'retailVat', coalesce((SELECT vat FROM till), 0) + coalesce((SELECT vat FROM bills), 0),
    'appointments', (SELECT count(*) FROM appointment a WHERE a.business_unit_id = p_bu AND a.status = 'completed'
                       AND a.completed_at >= p_from AND a.completed_at < p_to),
    'tickets', (SELECT count(*) FROM sale_ticket t WHERE t.business_unit_id = p_bu AND t.journal_entry_id IN (SELECT id FROM je)))
$$;

-- A month's statement as it would be issued now. "missing" lists terms still blank.
CREATE FUNCTION pt.compute(p_bu uuid, p_month date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_from  date := date_trunc('month', p_month)::date;
  v_to    date := (date_trunc('month', p_month) + interval '1 month')::date;
  g       partnership_agreement%ROWTYPE;
  f       jsonb;
  v_miss  text[] := '{}';
  v_base  numeric;
  v_share numeric;
  v_payer share_side;
BEGIN
  IF NOT pt.can_view(p_bu) THEN RAISE EXCEPTION 'unit not found' USING ERRCODE = 'no_data_found'; END IF;
  f := pt.figures(p_bu, v_from, v_to);
  g := pt.terms_on(p_bu, v_from);
  IF g.id IS NULL THEN
    v_miss := ARRAY['agreement'];
  ELSE
    IF g.rate_pct IS NULL THEN v_miss := array_append(v_miss, 'rate'); END IF;
    IF g.beneficiary IS NULL THEN v_miss := array_append(v_miss, 'beneficiary'); END IF;
    IF g.basis IS NULL THEN v_miss := array_append(v_miss, 'basis'); END IF;
    IF g.collector IS NULL THEN v_miss := array_append(v_miss, 'collector'); END IF;
    IF g.include_retail IS NULL THEN v_miss := array_append(v_miss, 'retail'); END IF;
  END IF;
  IF cardinality(v_miss) = 0 THEN
    v_base := CASE g.basis
      WHEN 'gross' THEN (f->>'net')::numeric + (f->>'serviceCharge')::numeric + (f->>'vat')::numeric
        - CASE WHEN g.include_retail THEN 0 ELSE (f->>'retailNet')::numeric + (f->>'retailServiceCharge')::numeric + (f->>'retailVat')::numeric END
      WHEN 'net_of_vat' THEN (f->>'net')::numeric + (f->>'serviceCharge')::numeric
        - CASE WHEN g.include_retail THEN 0 ELSE (f->>'retailNet')::numeric + (f->>'retailServiceCharge')::numeric END
      ELSE (f->>'net')::numeric - CASE WHEN g.include_retail THEN 0 ELSE (f->>'retailNet')::numeric END END;
    v_share := round(v_base * g.rate_pct / 100, 2);
    v_payer := CASE WHEN g.collector <> g.beneficiary THEN g.collector ELSE g.beneficiary END;
  END IF;
  RETURN jsonb_build_object(
    'periodStart', v_from, 'periodEnd', v_to, 'figures', f, 'missing', to_jsonb(v_miss),
    'agreement', CASE WHEN g.id IS NULL THEN NULL ELSE jsonb_build_object('id', g.id, 'version', g.version, 'ratePct', g.rate_pct,
      'beneficiary', g.beneficiary, 'basis', g.basis, 'collector', g.collector, 'includeRetail', g.include_retail,
      'effectiveFrom', g.effective_from) END,
    'base', v_base, 'share', v_share, 'payer', v_payer, 'payee', CASE WHEN v_payer IS NOT NULL THEN pt.other(v_payer) END,
    'amount', CASE WHEN v_payer IS NULL THEN NULL WHEN g.collector <> g.beneficiary THEN v_share ELSE v_base - v_share END,
    'ended', v_to <= current_date);
END $$;

CREATE FUNCTION pt.issue(p_bu uuid, p_month date) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_side share_side; c jsonb; v_id uuid;
BEGIN
  v_side := pt.require_side(p_bu);
  c := pt.compute(p_bu, p_month);
  IF NOT (c->>'ended')::boolean THEN
    RAISE EXCEPTION 'a month can be settled once it has ended' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(c->'missing') > 0 THEN
    RAISE EXCEPTION 'the agreement terms are not complete (missing: %)',
      (SELECT string_agg(x, ', ') FROM jsonb_array_elements_text(c->'missing') x) USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM settlement_statement WHERE business_unit_id = p_bu AND period_start = (c->>'periodStart')::date AND status <> 'withdrawn') THEN
    RAISE EXCEPTION 'that month already has a statement' USING ERRCODE = 'GD409';
  END IF;
  INSERT INTO settlement_statement (tenant_id, business_unit_id, statement_number, period_start, period_end, agreement_id,
                                    figures, base, share, payer, payee, amount, issued_side, issued_by)
  VALUES (sec.current_tenant_id(), p_bu, inv.next_doc_number(p_bu, 'SET'), (c->>'periodStart')::date, (c->>'periodEnd')::date,
          (c->'agreement'->>'id')::uuid, c, (c->>'base')::numeric, (c->>'share')::numeric, (c->>'payer')::share_side,
          (c->>'payee')::share_side, (c->>'amount')::numeric, v_side, sec.current_user_id())
  RETURNING id INTO v_id;
  PERFORM pt.notify_side(p_bu, pt.other(v_side), 'Settlement statement issued',
    format('%s: %s to pay %s. Please review and agree.', to_char((c->>'periodStart')::date, 'Mon YYYY'),
           initcap(c->>'payer'), to_char((c->>'amount')::numeric, 'FM999,999,999,990.00')));
  RETURN v_id;
END $$;

CREATE FUNCTION pt.lock_statement(p_statement uuid) RETURNS settlement_statement
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s settlement_statement%ROWTYPE;
BEGIN
  SELECT * INTO s FROM settlement_statement WHERE id = p_statement AND tenant_id = sec.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR NOT pt.can_view(s.business_unit_id) THEN RAISE EXCEPTION 'statement not found' USING ERRCODE = 'no_data_found'; END IF;
  RETURN s;
END $$;

-- The other side agrees; the share is accrued in the unit's books.
CREATE FUNCTION pt.agree(p_statement uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s settlement_statement%ROWTYPE; v_side share_side; v_je bigint;
BEGIN
  s := pt.lock_statement(p_statement);
  v_side := pt.require_side(s.business_unit_id);
  IF s.status <> 'issued' THEN RAISE EXCEPTION 'only an issued statement can be agreed' USING ERRCODE = 'check_violation'; END IF;
  IF v_side = s.issued_side THEN RAISE EXCEPTION 'the other side must agree the statement' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF s.amount > 0 THEN
    v_je := fin.post_entry(s.business_unit_id, current_date, 'settlement', s.id::text,
      'Revenue share ' || to_char(s.period_start, 'Mon YYYY') || ' · ' || s.statement_number,
      CASE s.payer WHEN 'partner' THEN jsonb_build_array(       -- the unit (partner) owes the Owner
             jsonb_build_object('code', '5400', 'debit', s.amount), jsonb_build_object('code', '2300', 'credit', s.amount))
                   ELSE jsonb_build_array(                       -- the Owner owes the unit (partner)
             jsonb_build_object('code', '1160', 'debit', s.amount), jsonb_build_object('code', '4400', 'credit', s.amount)) END);
  END IF;
  UPDATE settlement_statement SET status = 'agreed', agreed_by = sec.current_user_id(), agreed_at = now(), accrual_entry_id = v_je
   WHERE id = s.id;
  PERFORM pt.notify_side(s.business_unit_id, s.issued_side, 'Settlement statement agreed', s.statement_number);
END $$;

CREATE FUNCTION pt.record_payment(p_statement uuid, p_method payment_method, p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s settlement_statement%ROWTYPE; v_je bigint;
BEGIN
  s := pt.lock_statement(p_statement);
  PERFORM pt.require_side(s.business_unit_id);
  IF s.status <> 'agreed' THEN RAISE EXCEPTION 'record payment once the statement is agreed' USING ERRCODE = 'check_violation'; END IF;
  IF p_method IS NULL OR p_method::text NOT IN ('cash', 'transfer') THEN
    RAISE EXCEPTION 'choose bank transfer or cash' USING ERRCODE = 'check_violation';
  END IF;
  IF s.amount > 0 THEN
    v_je := fin.post_entry(s.business_unit_id, current_date, 'settlement', s.id::text,
      'Revenue share paid · ' || s.statement_number || coalesce(' · ' || nullif(trim(p_reference), ''), ''),
      CASE s.payer WHEN 'partner' THEN jsonb_build_array(
             jsonb_build_object('code', '2300', 'debit', s.amount), jsonb_build_object('code', fin.method_account(p_method), 'credit', s.amount))
                   ELSE jsonb_build_array(
             jsonb_build_object('code', fin.method_account(p_method), 'debit', s.amount), jsonb_build_object('code', '1160', 'credit', s.amount)) END);
  END IF;
  UPDATE settlement_statement SET status = 'paid', paid_by = sec.current_user_id(), paid_at = now(), payment_method = p_method,
         payment_reference = nullif(trim(coalesce(p_reference, '')), ''), payment_entry_id = v_je
   WHERE id = s.id;
  PERFORM pt.notify_side(s.business_unit_id, pt.other(pt.side(s.business_unit_id)), 'Settlement paid', s.statement_number);
END $$;

CREATE FUNCTION pt.withdraw_statement(p_statement uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s settlement_statement%ROWTYPE;
BEGIN
  s := pt.lock_statement(p_statement);
  IF pt.require_side(s.business_unit_id) <> s.issued_side THEN
    RAISE EXCEPTION 'only the side that issued it can withdraw it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF s.status <> 'issued' THEN RAISE EXCEPTION 'an agreed statement cannot be withdrawn' USING ERRCODE = 'check_violation'; END IF;
  UPDATE settlement_statement SET status = 'withdrawn', withdrawn_by = sec.current_user_id(), withdrawn_at = now() WHERE id = s.id;
END $$;

-- =====================================================================
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON partnership_agreement FOR EACH ROW EXECUTE FUNCTION sec.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE ON settlement_statement  FOR EACH ROW EXECUTE FUNCTION sec.audit_row();

ALTER TABLE partnership_agreement ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_statement  ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreement_read ON partnership_agreement FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND pt.can_view(business_unit_id));
CREATE POLICY statement_read ON settlement_statement FOR SELECT TO giddy_app
  USING (tenant_id = sec.current_tenant_id() AND pt.can_view(business_unit_id));
GRANT SELECT ON partnership_agreement, settlement_statement TO giddy_app;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pt FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  pt.side(uuid), pt.can_view(uuid), pt.terms_on(uuid, date), pt.propose(uuid, jsonb, date, text), pt.decide(uuid, boolean, text),
  pt.withdraw_proposal(uuid), pt.compute(uuid, date), pt.issue(uuid, date), pt.agree(uuid),
  pt.record_payment(uuid, payment_method, text), pt.withdraw_statement(uuid)
TO giddy_app;
