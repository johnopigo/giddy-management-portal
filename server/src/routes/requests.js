import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const reqParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const createSchema = z.object({
  fromLocationId: z.uuid(),
  toLocationId: z.uuid(),
  neededBy: z.iso.date().nullish(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(z.object({ itemId: z.uuid(), qty: z.number().positive().max(1e9) })).min(1).max(100),
});
const decisionSchema = z.object({
  note: z.string().trim().max(500).nullish(),
  lines: z.array(z.object({ lineId: z.uuid(), qtyApproved: z.number().nonnegative() })).max(100).nullish(),
});

export function requestRoutes() {
  const router = Router();

  router.get('/:businessUnitId', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT r.id, r.request_number, r.status, r.requested_by, sec.user_name(r.requested_by) AS requested_by_name,
              r.requested_at, r.needed_by, r.notes, fl.name AS from_location_name, tl.name AS to_location_name,
              sec.user_name(r.decided_by) AS decided_by_name, r.decided_at, r.decision_note,
              sec.user_name(r.fulfilled_by) AS fulfilled_by_name, r.fulfilled_at,
              r.requested_by = sec.current_user_id() AS is_mine,
              (SELECT jsonb_agg(jsonb_build_object('id', l.id, 'item_id', l.item_id, 'item_name', i.name, 'uom', u.code,
                                                   'qty_requested', l.qty_requested, 'qty_approved', l.qty_approved)
                                ORDER BY i.name)
                 FROM item_request_line l JOIN item i ON i.id = l.item_id JOIN unit_of_measure u ON u.id = i.base_uom_id
                WHERE l.item_request_id = r.id) AS lines
         FROM item_request r
         JOIN stock_location fl ON fl.id = r.from_location_id
         JOIN stock_location tl ON tl.id = r.to_location_id
        WHERE r.business_unit_id = $1
        ORDER BY (r.status IN ('pending', 'approved')) DESC, r.requested_at DESC LIMIT 200`, [businessUnitId])).rows);
    res.json(rows);
  });

  router.post('/:businessUnitId', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(createSchema, req.body);
    const id = await req.db(async (c) => (await c.query(
      'SELECT inv.request_create($1, $2, $3, $4, $5, $6) AS id',
      [businessUnitId, b.fromLocationId, b.toLocationId, b.neededBy ?? null, b.notes ?? null, JSON.stringify(b.lines)])).rows[0].id);
    res.status(201).json({ id });
  });

  for (const action of ['approve', 'reject', 'fulfil', 'cancel']) {
    router.post(`/:businessUnitId/:id/${action}`, async (req, res) => {
      const { id } = parse(reqParams, req.params);
      const b = parse(decisionSchema, req.body ?? {});
      await req.db((c) => c.query('SELECT inv.request_act($1, $2, $3, $4)',
        [id, action, b.note ?? null, b.lines ? JSON.stringify(b.lines) : null]));
      res.status(204).end();
    });
  }

  return router;
}
