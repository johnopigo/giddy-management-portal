import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const uomSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, 'Use lower-case letters, digits or underscores.'),
  name: z.string().trim().min(1).max(60),
});
const categorySchema = z.object({ name: z.string().trim().min(2).max(80), parentId: z.uuid().nullish() });
const itemSchema = z.object({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{1,39}$/, 'Use 2–40 letters, digits, dots, dashes or underscores.'),
  name: z.string().trim().min(2).max(160),
  categoryId: z.uuid().nullish(),
  baseUomId: z.uuid(),
  ownerBusinessUnitId: z.uuid().nullish(),
  isStockable: z.boolean().default(true),
  isSellable: z.boolean().default(false),
  isBatchTracked: z.boolean().default(false),
  isExpiryTracked: z.boolean().default(false),
});
const itemPatch = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  categoryId: z.uuid().nullish(),
  isSellable: z.boolean().optional(),
  isActive: z.boolean().optional(),
  rowVersion: z.int(),
});
const unitItemSchema = z.object({
  sellPrice: z.number().nonnegative().max(1e11).nullish(),
  reorderLevel: z.number().nonnegative().default(0),
  reorderQty: z.number().nonnegative().default(0),
  isActive: z.boolean().default(true),
});
const conversionsSchema = z.array(z.object({ uomId: z.uuid(), factorToBase: z.number().positive() })).max(20);
const itemListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  businessUnitId: z.uuid().optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});
const itemUnitParams = z.object({ id: z.uuid(), businessUnitId: z.uuid() });

export function catalogRoutes() {
  const router = Router();

  router.get('/', async (req, res) => {
    const data = await req.db(async (c) => ({
      uoms: (await c.query('SELECT id, code, name FROM unit_of_measure ORDER BY code')).rows,
      categories: (await c.query('SELECT id, parent_id, name FROM item_category ORDER BY name')).rows,
    }));
    res.json(data);
  });

  router.post('/uoms', async (req, res) => {
    const b = parse(uomSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      'INSERT INTO unit_of_measure (tenant_id, code, name) VALUES (sec.current_tenant_id(), $1, $2) RETURNING *',
      [b.code, b.name])).rows[0]);
    res.status(201).json(row);
  });

  router.post('/categories', async (req, res) => {
    const b = parse(categorySchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      'INSERT INTO item_category (tenant_id, parent_id, name) VALUES (sec.current_tenant_id(), $1, $2) RETURNING *',
      [b.parentId ?? null, b.name])).rows[0]);
    res.status(201).json(row);
  });

  // With businessUnitId, each item also carries that unit's price and reorder settings
  // (only if the caller may see them: row-level security filters business_unit_item).
  router.get('/items', async (req, res) => {
    const q = parse(itemListQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT i.id, i.sku, i.name, i.category_id, cat.name AS category_name, i.base_uom_id, u.code AS base_uom,
              i.owner_business_unit_id, ob.name AS owner_business_unit_name,
              i.is_stockable, i.is_sellable, i.is_batch_tracked, i.is_expiry_tracked, i.is_active, i.row_version,
              sec.can_manage_master(i.owner_business_unit_id) AS can_manage,
              bui.sell_price, bui.reorder_level, bui.reorder_qty, bui.is_active AS enabled_in_unit,
              bui.row_version AS unit_row_version,
              coalesce((SELECT jsonb_agg(jsonb_build_object('uom_id', cv.uom_id, 'code', cu.code, 'factor_to_base', cv.factor_to_base))
                          FROM item_uom_conversion cv JOIN unit_of_measure cu ON cu.id = cv.uom_id
                         WHERE cv.item_id = i.id), '[]') AS conversions
         FROM item i
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         LEFT JOIN item_category cat ON cat.id = i.category_id
         LEFT JOIN business_unit ob ON ob.id = i.owner_business_unit_id
         LEFT JOIN business_unit_item bui ON bui.item_id = i.id AND bui.business_unit_id = $2
        WHERE ($1::text IS NULL OR i.name ILIKE '%' || $1 || '%' OR i.sku ILIKE $1 || '%')
          AND ($3 OR i.is_active)
        ORDER BY i.name LIMIT 500`,
      [q.q || null, q.businessUnitId ?? null, q.includeInactive === 'true'])).rows);
    res.json(rows);
  });

  router.post('/items', async (req, res) => {
    const b = parse(itemSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO item (tenant_id, owner_business_unit_id, sku, name, category_id, base_uom_id,
                         is_stockable, is_sellable, is_batch_tracked, is_expiry_tracked)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [b.ownerBusinessUnitId ?? null, b.sku, b.name, b.categoryId ?? null, b.baseUomId,
       b.isStockable, b.isSellable, b.isBatchTracked || b.isExpiryTracked, b.isExpiryTracked])).rows[0]);
    res.status(201).json(row);
  });

  // Tracking flags (batch / expiry / stockable) are fixed at creation: changing them
  // after stock exists would invalidate the ledger.
  router.patch('/items/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const b = parse(itemPatch, req.body);
    const row = await req.db(async (c) => (await c.query(
      `UPDATE item SET name = coalesce($2, name),
                       category_id = CASE WHEN $3::boolean THEN $4::uuid ELSE category_id END,
                       is_sellable = coalesce($5, is_sellable), is_active = coalesce($6, is_active)
        WHERE id = $1 AND row_version = $7 RETURNING *`,
      [id, b.name ?? null, b.categoryId !== undefined, b.categoryId ?? null, b.isSellable ?? null,
       b.isActive ?? null, b.rowVersion])).rows[0]);
    if (!row) throw notFound('Item not found, you cannot change it, or it was changed by someone else.');
    res.json(row);
  });

  router.put('/items/:id/conversions', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const list = parse(conversionsSchema, req.body);
    const rows = await req.db(async (c) => {
      await c.query('DELETE FROM item_uom_conversion WHERE item_id = $1', [id]);
      for (const cv of list) {
        await c.query(
          `INSERT INTO item_uom_conversion (tenant_id, item_id, uom_id, factor_to_base)
           VALUES (sec.current_tenant_id(), $1, $2, $3)`, [id, cv.uomId, cv.factorToBase]);
      }
      return (await c.query('SELECT uom_id, factor_to_base FROM item_uom_conversion WHERE item_id = $1', [id])).rows;
    });
    res.json(rows);
  });

  // Enable an item in a unit and set its price / reorder rules there.
  router.put('/items/:id/units/:businessUnitId', async (req, res) => {
    const { id, businessUnitId } = parse(itemUnitParams, req.params);
    const b = parse(unitItemSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO business_unit_item (tenant_id, business_unit_id, item_id, sell_price, reorder_level, reorder_qty, is_active)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_unit_id, item_id) DO UPDATE
         SET sell_price = EXCLUDED.sell_price, reorder_level = EXCLUDED.reorder_level,
             reorder_qty = EXCLUDED.reorder_qty, is_active = EXCLUDED.is_active, updated_at = now()
       RETURNING *`,
      [businessUnitId, id, b.sellPrice ?? null, b.reorderLevel, b.reorderQty, b.isActive])).rows[0]);
    res.json(row);
  });

  return router;
}
