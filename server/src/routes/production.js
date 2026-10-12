import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const orderParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const createSchema = z.object({
  recipeId: z.uuid(),
  plannedQty: z.number().positive().max(1e6),
  fromLocationId: z.uuid(),
  toLocationId: z.uuid(),
  plannedFor: z.iso.date().nullish(),
  notes: z.string().max(1000).nullish(),
});
const completeSchema = z.object({
  actualOutput: z.number().nonnegative().max(1e6),
  expiryDate: z.iso.date().nullish(),
  lines: z.array(z.object({ lineId: z.uuid(), actualQty: z.number().nonnegative() })).max(100).nullish(),
});

export function productionRoutes() {
  const router = Router();

  // Orders with yield variance. Costs only for finance readers.
  router.get('/:businessUnitId', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT o.id, o.order_number, o.status, o.recipe_id, i.name AS output_name, u.code AS output_uom,
              o.planned_output_qty, o.actual_output_qty,
              CASE WHEN o.actual_output_qty IS NOT NULL
                   THEN round((o.actual_output_qty - o.planned_output_qty) / o.planned_output_qty * 100, 1) END AS yield_variance_pct,
              fl.name AS from_location_name, tl.name AS to_location_name, o.planned_for, o.notes,
              CASE WHEN sec.has_scope($1, 'FIN') THEN o.input_cost END AS input_cost,
              CASE WHEN sec.has_scope($1, 'FIN') THEN o.output_unit_cost END AS output_unit_cost,
              sec.user_name(o.created_by) AS created_by_name, o.created_at,
              sec.user_name(o.completed_by) AS completed_by_name, o.completed_at,
              (SELECT jsonb_agg(jsonb_build_object('id', l.id, 'item_id', l.item_id, 'name', li.name, 'uom', lu.code,
                                                   'planned_qty', l.planned_qty, 'actual_qty', l.actual_qty,
                                                   'cost_amount', CASE WHEN sec.has_scope($1, 'FIN') THEN l.cost_amount END)
                                ORDER BY li.name)
                 FROM production_order_line l JOIN item li ON li.id = l.item_id JOIN unit_of_measure lu ON lu.id = li.base_uom_id
                WHERE l.production_order_id = o.id) AS lines
         FROM production_order o
         JOIN item i ON i.id = o.output_item_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         JOIN stock_location fl ON fl.id = o.from_location_id
         JOIN stock_location tl ON tl.id = o.to_location_id
        WHERE o.business_unit_id = $1
        ORDER BY (o.status = 'planned') DESC, o.created_at DESC LIMIT 200`, [businessUnitId])).rows);
    res.json(rows);
  });

  router.post('/:businessUnitId', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(createSchema, req.body);
    const id = await req.db(async (c) => (await c.query(
      'SELECT inv.production_create($1, $2, $3, $4, $5, $6, $7) AS id',
      [businessUnitId, b.recipeId, b.plannedQty, b.fromLocationId, b.toLocationId, b.plannedFor ?? null, b.notes ?? null])).rows[0].id);
    res.status(201).json({ id });
  });

  router.post('/:businessUnitId/:id/complete', async (req, res) => {
    const { id } = parse(orderParams, req.params);
    const b = parse(completeSchema, req.body);
    await req.db((c) => c.query('SELECT inv.production_complete($1, $2, $3, $4)',
      [id, b.actualOutput, b.expiryDate ?? null, b.lines ? JSON.stringify(b.lines) : null]));
    res.status(204).end();
  });

  router.post('/:businessUnitId/:id/cancel', async (req, res) => {
    const { id } = parse(orderParams, req.params);
    await req.db((c) => c.query('SELECT inv.production_cancel($1)', [id]));
    res.status(204).end();
  });

  return router;
}
