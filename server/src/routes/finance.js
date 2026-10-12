import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const periodParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const tbQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const journalQuery = z.object({
  beforeId: z.coerce.number().int().positive().optional(),
  accountCode: z.string().regex(/^[0-9]{4}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function financeRoutes() {
  const router = Router();

  // Trial balance: every account with its debit and credit totals and balance. Must sum to zero.
  router.get('/:businessUnitId/trial-balance', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const q = parse(tbQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT a.code, a.name, a.account_type,
              coalesce(sum(l.debit), 0) AS debit, coalesce(sum(l.credit), 0) AS credit,
              coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0) AS balance
         FROM ledger_account a
         LEFT JOIN journal_line l ON l.account_id = a.id
              AND EXISTS (SELECT 1 FROM journal_entry e WHERE e.id = l.journal_entry_id
                           AND ($2::date IS NULL OR e.entry_date >= $2) AND ($3::date IS NULL OR e.entry_date <= $3))
        WHERE a.business_unit_id = $1
        GROUP BY a.code, a.name, a.account_type ORDER BY a.code`,
      [businessUnitId, q.from ?? null, q.to ?? null])).rows);
    res.json(rows);
  });

  router.get('/:businessUnitId/journal', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const q = parse(journalQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT e.id::int AS id, e.entry_date, e.source_doc_type, e.source_doc_id, e.memo, e.reverses_entry_id::int AS reverses_entry_id,
              sec.user_name(e.posted_by) AS posted_by_name, e.posted_at,
              (SELECT jsonb_agg(jsonb_build_object('code', a.code, 'name', a.name, 'debit', l.debit, 'credit', l.credit,
                                                   'counterparty', cp.name) ORDER BY l.debit DESC, a.code)
                 FROM journal_line l JOIN ledger_account a ON a.id = l.account_id
                 LEFT JOIN business_unit cp ON cp.id = l.counterparty_business_unit_id
                WHERE l.journal_entry_id = e.id) AS lines
         FROM journal_entry e
        WHERE e.business_unit_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM journal_line l JOIN ledger_account a ON a.id = l.account_id
                                           WHERE l.journal_entry_id = e.id AND a.code = $3))
        ORDER BY e.id DESC LIMIT $4`,
      [businessUnitId, q.beforeId ?? null, q.accountCode ?? null, q.limit])).rows);
    res.json(rows);
  });

  router.get('/:businessUnitId/periods', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT p.id, p.period_start, p.period_end, p.status, sec.user_name(p.closed_by) AS closed_by_name, p.closed_at,
              (SELECT count(*)::int FROM journal_entry e WHERE e.period_id = p.id) AS entries
         FROM fiscal_period p WHERE p.business_unit_id = $1 ORDER BY p.period_start DESC`, [businessUnitId])).rows);
    res.json(rows);
  });

  router.post('/:businessUnitId/periods/:id/close', async (req, res) => {
    const { id } = parse(periodParams, req.params);
    await req.db((c) => c.query('SELECT fin.close_period($1)', [id]));
    res.status(204).end();
  });

  return router;
}
