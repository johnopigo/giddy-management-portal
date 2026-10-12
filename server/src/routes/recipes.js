import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const itemParams = z.object({ businessUnitId: z.uuid(), itemId: z.uuid() });
const saveSchema = z.object({
  yieldQty: z.number().positive().max(1e6).default(1),
  notes: z.string().max(2000).nullish(),
  isActive: z.boolean().default(true),
  lines: z.array(z.object({ itemId: z.uuid(), qty: z.number().positive().max(1e6) })).min(1).max(100),
});

export function recipeRoutes() {
  const router = Router();

  // Each recipe with its ingredients. Cost per unit of output (at current average cost) and the
  // margin against the selling price are financial: shown only with finance read in the unit.
  router.get('/:businessUnitId', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT r.id, r.output_item_id, i.name AS output_name, i.sku AS output_sku, u.code AS output_uom,
              i.is_stockable AS output_is_stockable, r.yield_qty, r.notes, r.is_active, r.updated_at,
              sec.user_name(r.updated_by) AS updated_by_name,
              CASE WHEN sec.has_scope($1, 'FIN') THEN bui.sell_price END AS sell_price,
              CASE WHEN sec.has_scope($1, 'FIN') THEN
                round((SELECT coalesce(sum(rl.qty * ic.avg_unit_cost), 0) FROM recipe_line rl
                         LEFT JOIN item_cost ic ON ic.business_unit_id = r.business_unit_id AND ic.item_id = rl.item_id
                        WHERE rl.recipe_id = r.id) / r.yield_qty, 2) END AS unit_cost,
              (SELECT jsonb_agg(jsonb_build_object('item_id', rl.item_id, 'name', li.name, 'uom', lu.code, 'qty', rl.qty,
                                                   'avg_cost', CASE WHEN sec.has_scope($1, 'FIN') THEN ic.avg_unit_cost END)
                                ORDER BY li.name)
                 FROM recipe_line rl JOIN item li ON li.id = rl.item_id JOIN unit_of_measure lu ON lu.id = li.base_uom_id
                 LEFT JOIN item_cost ic ON ic.business_unit_id = r.business_unit_id AND ic.item_id = rl.item_id
                WHERE rl.recipe_id = r.id) AS lines
         FROM recipe r
         JOIN item i ON i.id = r.output_item_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         LEFT JOIN business_unit_item bui ON bui.business_unit_id = r.business_unit_id AND bui.item_id = r.output_item_id
        WHERE r.business_unit_id = $1
        ORDER BY i.name`, [businessUnitId])).rows);
    res.json(rows.map((r) => ({
      ...r,
      margin_pct: r.sell_price && r.unit_cost !== null && Number(r.sell_price) > 0
        ? Math.round((1 - Number(r.unit_cost) / Number(r.sell_price)) * 1000) / 10 : null,
    })));
  });

  // Create or replace the recipe for an output item.
  router.put('/:businessUnitId/:itemId', async (req, res) => {
    const { businessUnitId, itemId } = parse(itemParams, req.params);
    const b = parse(saveSchema, req.body);
    const id = await req.db(async (c) => (await c.query(
      'SELECT inv.recipe_save($1, $2, $3, $4, $5, $6) AS id',
      [businessUnitId, itemId, b.yieldQty, b.notes ?? null, b.isActive, JSON.stringify(b.lines)])).rows[0].id);
    res.json({ id });
  });

  return router;
}
