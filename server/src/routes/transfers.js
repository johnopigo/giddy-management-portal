import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/validate.js';

const dispatchSchema = z.object({
  fromBusinessUnitId: z.uuid(),
  toBusinessUnitId: z.uuid(),
  fromLocationId: z.uuid(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(z.object({ itemId: z.uuid(), qty: z.number().positive().max(1e9) })).min(1).max(100),
});
const receiveSchema = z.object({ toLocationId: z.uuid() });
const rejectSchema = z.object({ reason: z.string().trim().min(2).max(500) });

export function transferRoutes() {
  const router = Router();

  // Each side sees transfers it sends or receives. Costs only for those with finance read on either side.
  router.get('/', async (req, res) => {
    const rows = await req.db(async (c) => (await c.query(
      `SELECT t.id, t.transfer_number, t.status, t.notes, t.from_business_unit_id, fb.name AS from_unit_name,
              t.to_business_unit_id, tb.name AS to_unit_name,
              CASE WHEN sec.has_scope(t.from_business_unit_id, 'OPS') THEN fl.name END AS from_location_name,
              CASE WHEN sec.has_scope(t.to_business_unit_id, 'OPS') THEN tl.name END AS to_location_name,
              t.dispatched_at, sec.user_name(t.dispatched_by) AS dispatched_by_name,
              t.received_at, sec.user_name(t.received_by) AS received_by_name,
              t.rejected_at, t.reject_reason, t.returned_at,
              sec.has_scope(t.to_business_unit_id, 'OPS', true) AS can_receive,
              sec.has_scope(t.from_business_unit_id, 'OPS', true) AS can_return,
              (SELECT jsonb_agg(jsonb_build_object(
                        'item_name', i.name, 'qty', l.qty, 'batch_no', l.batch_no, 'expiry_date', l.expiry_date,
                        'unit_cost', CASE WHEN sec.has_scope(t.from_business_unit_id, 'FIN') OR sec.has_scope(t.to_business_unit_id, 'FIN')
                                          THEN l.unit_cost END) ORDER BY i.name)
                 FROM inter_unit_transfer_line l JOIN item i ON i.id = l.item_id WHERE l.transfer_id = t.id) AS lines
         FROM inter_unit_transfer t
         JOIN business_unit fb ON fb.id = t.from_business_unit_id
         JOIN business_unit tb ON tb.id = t.to_business_unit_id
         LEFT JOIN stock_location fl ON fl.id = t.from_location_id
         LEFT JOIN stock_location tl ON tl.id = t.to_location_id
        ORDER BY t.dispatched_at DESC LIMIT 200`)).rows);
    res.json(rows);
  });

  router.post('/', async (req, res) => {
    const b = parse(dispatchSchema, req.body);
    const id = await req.db(async (c) => (await c.query(
      'SELECT inv.transfer_dispatch($1, $2, $3, $4, $5) AS id',
      [b.fromBusinessUnitId, b.toBusinessUnitId, b.fromLocationId, b.notes ?? null, JSON.stringify(b.lines)])).rows[0].id);
    res.status(201).json({ id });
  });

  router.post('/:id/receive', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { toLocationId } = parse(receiveSchema, req.body);
    await req.db((c) => c.query(`SELECT inv.transfer_act($1, 'receive', $2, NULL)`, [id, toLocationId]));
    res.status(204).end();
  });

  router.post('/:id/reject', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(rejectSchema, req.body);
    await req.db((c) => c.query(`SELECT inv.transfer_act($1, 'reject', NULL, $2)`, [id, reason]));
    res.status(204).end();
  });

  router.post('/:id/return', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await req.db((c) => c.query(`SELECT inv.transfer_act($1, 'return', NULL, NULL)`, [id]));
    res.status(204).end();
  });

  return router;
}
