import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const idParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const side = z.enum(['owner', 'partner']);
const proposeSchema = z.object({
  ratePct: z.number().min(0).max(100).nullish(),
  beneficiary: side.nullish(),
  basis: z.enum(['gross', 'net_of_vat', 'net']).nullish(),
  collector: side.nullish(),
  includeRetail: z.boolean().nullish(),
  effectiveFrom: z.iso.date(),
  notes: z.string().trim().max(2000).nullish(),
});
const decideSchema = z.object({ accept: z.boolean(), note: z.string().trim().max(500).nullish() });
const monthSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM') });
const paymentSchema = z.object({ method: z.enum(['transfer', 'cash']), reference: z.string().trim().max(80).nullish() });

const AGREEMENT = `SELECT g.id, g.version, g.status, g.rate_pct, g.beneficiary, g.basis, g.collector, g.include_retail,
         g.effective_from, g.notes, g.proposed_side, sec.user_name(g.proposed_by) AS proposed_by_name, g.proposed_at,
         sec.user_name(g.decided_by) AS decided_by_name, g.decided_at, g.decision_note
    FROM partnership_agreement g`;
const STATEMENT = `SELECT s.id, s.statement_number, s.period_start, s.period_end, s.figures, s.base, s.share, s.payer, s.payee,
         s.amount, s.status, s.issued_side, sec.user_name(s.issued_by) AS issued_by_name, s.issued_at,
         sec.user_name(s.agreed_by) AS agreed_by_name, s.agreed_at, sec.user_name(s.paid_by) AS paid_by_name, s.paid_at,
         s.payment_method, s.payment_reference, s.withdrawn_at
    FROM settlement_statement s`;

export function partnershipRoutes() {
  const router = Router();

  // Partnership units the user can see settlements for, and which side they speak for.
  router.get('/units', async (req, res) => {
    res.json(await req.db(async (c) => (await c.query(
      `SELECT bu.id, bu.code, bu.name, pt.side(bu.id) AS my_side FROM business_unit bu
        WHERE bu.management_model = 'partnership' AND pt.can_view(bu.id) ORDER BY bu.name`)).rows));
  });

  router.get('/:businessUnitId/agreements', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const data = await req.db(async (c) => {
      const rows = (await c.query(`${AGREEMENT} WHERE g.business_unit_id = $1 ORDER BY g.version DESC`, [businessUnitId])).rows;
      const current = (await c.query(`SELECT (pt.terms_on($1, current_date)).id`, [businessUnitId])).rows[0]?.id ?? null;
      const mySide = (await c.query('SELECT pt.side($1) AS s', [businessUnitId])).rows[0].s;
      return { mySide, currentId: current, agreements: rows };
    });
    res.json(data);
  });

  router.post('/:businessUnitId/agreements', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(proposeSchema, req.body);
    const id = await req.db(async (c) => (await c.query('SELECT pt.propose($1, $2, $3, $4) AS id', [businessUnitId,
      JSON.stringify({ ratePct: b.ratePct ?? null, beneficiary: b.beneficiary ?? null, basis: b.basis ?? null,
        collector: b.collector ?? null, includeRetail: b.includeRetail ?? null }), b.effectiveFrom, b.notes ?? null])).rows[0].id);
    res.status(201).json({ id });
  });

  const inUnit = async (c, table, id, businessUnitId) => {
    const r = (await c.query(`SELECT 1 FROM ${table} WHERE id = $1 AND business_unit_id = $2`, [id, businessUnitId])).rows[0];
    if (!r) throw notFound(table === 'partnership_agreement' ? 'Agreement not found.' : 'Statement not found.');
  };

  router.post('/:businessUnitId/agreements/:id/decide', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const b = parse(decideSchema, req.body);
    await req.db(async (c) => {
      await inUnit(c, 'partnership_agreement', id, businessUnitId);
      await c.query('SELECT pt.decide($1, $2, $3)', [id, b.accept, b.note ?? null]);
    });
    res.status(204).end();
  });

  router.post('/:businessUnitId/agreements/:id/withdraw', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    await req.db(async (c) => {
      await inUnit(c, 'partnership_agreement', id, businessUnitId);
      await c.query('SELECT pt.withdraw_proposal($1)', [id]);
    });
    res.status(204).end();
  });

  router.get('/:businessUnitId/preview', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { month } = parse(monthSchema, req.query);
    res.json(await req.db(async (c) => (await c.query('SELECT pt.compute($1, $2) AS c', [businessUnitId, `${month}-01`])).rows[0].c));
  });

  router.get('/:businessUnitId/statements', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    res.json(await req.db(async (c) => (await c.query(
      `${STATEMENT} WHERE s.business_unit_id = $1 ORDER BY s.period_start DESC, s.issued_at DESC`, [businessUnitId])).rows));
  });

  router.post('/:businessUnitId/statements', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { month } = parse(monthSchema, req.body);
    const id = await req.db(async (c) => (await c.query('SELECT pt.issue($1, $2) AS id', [businessUnitId, `${month}-01`])).rows[0].id);
    res.status(201).json({ id });
  });

  for (const [path, sql] of [['agree', 'SELECT pt.agree($1)'], ['withdraw', 'SELECT pt.withdraw_statement($1)']]) {
    router.post(`/:businessUnitId/statements/:id/${path}`, async (req, res) => {
      const { businessUnitId, id } = parse(idParams, req.params);
      await req.db(async (c) => { await inUnit(c, 'settlement_statement', id, businessUnitId); await c.query(sql, [id]); });
      res.status(204).end();
    });
  }

  router.post('/:businessUnitId/statements/:id/payment', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const b = parse(paymentSchema, req.body);
    await req.db(async (c) => {
      await inUnit(c, 'settlement_statement', id, businessUnitId);
      await c.query('SELECT pt.record_payment($1, $2, $3)', [id, b.method, b.reference ?? null]);
    });
    res.status(204).end();
  });

  return router;
}
