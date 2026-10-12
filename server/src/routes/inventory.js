import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const locationParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const locationSchema = z.object({
  tier: z.enum(['branch', 'department', 'staff']),
  name: z.string().trim().min(2).max(100),
  branchId: z.uuid(),
  departmentId: z.uuid().nullish(),
  staffUserId: z.uuid().nullish(),
  parentLocationId: z.uuid().nullish(),
});
const locationPatch = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  isActive: z.boolean().optional(),
  rowVersion: z.int(),
});
const movementSchema = z.object({
  type: z.enum(['opening_balance', 'adjustment_in', 'adjustment_out', 'transfer', 'issue', 'wastage']),
  itemId: z.uuid(),
  qty: z.number().positive().max(1e9),
  fromLocationId: z.uuid().nullish(),
  toLocationId: z.uuid().nullish(),
  batchId: z.uuid().nullish(),
  batchNo: z.string().trim().max(60).nullish(),
  expiryDate: z.iso.date().nullish(),
  mfgDate: z.iso.date().nullish(),
  unitCost: z.number().nonnegative().max(1e11).nullish(),
  reason: z.string().trim().max(300).nullish(),
});
const balanceQuery = z.object({ locationId: z.uuid().optional(), itemId: z.uuid().optional() });
const movementQuery = z.object({
  itemId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const expiringQuery = z.object({ days: z.coerce.number().int().min(0).max(365).default(30) });

export function inventoryRoutes() {
  const router = Router({ mergeParams: true });

  router.get('/:businessUnitId/locations', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT l.id, l.tier, l.name, l.branch_id, b.name AS branch_name, l.department_id, d.name AS department_name,
              l.staff_user_id, sec.user_name(l.staff_user_id) AS staff_name, l.parent_location_id, l.is_active, l.row_version
         FROM stock_location l
         JOIN branch b ON b.id = l.branch_id
         LEFT JOIN department d ON d.id = l.department_id
        WHERE l.business_unit_id = $1
        ORDER BY l.tier, l.name`, [businessUnitId])).rows);
    res.json(rows);
  });

  router.post('/:businessUnitId/locations', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(locationSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO stock_location (tenant_id, business_unit_id, tier, name, branch_id, department_id, staff_user_id, parent_location_id)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [businessUnitId, b.tier, b.name, b.branchId, b.departmentId ?? null, b.staffUserId ?? null,
       b.parentLocationId ?? null])).rows[0]);
    res.status(201).json(row);
  });

  router.patch('/:businessUnitId/locations/:id', async (req, res) => {
    const { businessUnitId, id } = parse(locationParams, req.params);
    const b = parse(locationPatch, req.body);
    const row = await req.db(async (c) => (await c.query(
      `UPDATE stock_location SET name = coalesce($3, name), is_active = coalesce($4, is_active)
        WHERE id = $1 AND business_unit_id = $2 AND row_version = $5 RETURNING *`,
      [id, businessUnitId, b.name ?? null, b.isActive ?? null, b.rowVersion])).rows[0]);
    if (!row) throw notFound('Location not found, or it was changed by someone else.');
    res.json(row);
  });

  // Stock on hand per location / item / batch.
  router.get('/:businessUnitId/balances', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const q = parse(balanceQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT sb.location_id, l.name AS location_name, l.tier, sb.item_id, i.sku, i.name AS item_name,
              u.code AS uom, sb.batch_id, b.batch_no, b.expiry_date, sb.qty_on_hand, sb.updated_at
         FROM stock_balance sb
         JOIN stock_location l ON l.id = sb.location_id
         JOIN item i ON i.id = sb.item_id
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         LEFT JOIN item_batch b ON b.id = sb.batch_id
        WHERE sb.business_unit_id = $1 AND sb.qty_on_hand > 0
          AND ($2::uuid IS NULL OR sb.location_id = $2) AND ($3::uuid IS NULL OR sb.item_id = $3)
        ORDER BY i.name, l.name, b.expiry_date NULLS LAST`,
      [businessUnitId, q.locationId ?? null, q.itemId ?? null])).rows);
    res.json(rows);
  });

  // One line per enabled item: total on hand across the unit, reorder level, low-stock flag, nearest expiry.
  router.get('/:businessUnitId/summary', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT i.id AS item_id, i.sku, i.name AS item_name, u.code AS uom, bui.reorder_level, bui.reorder_qty,
              coalesce(t.on_hand, 0) AS on_hand, t.nearest_expiry,
              coalesce(t.on_hand, 0) <= bui.reorder_level AND bui.reorder_level > 0 AS is_low
         FROM business_unit_item bui
         JOIN item i ON i.id = bui.item_id AND i.is_stockable
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         LEFT JOIN LATERAL (
           SELECT sum(sb.qty_on_hand) AS on_hand,
                  min(b.expiry_date) FILTER (WHERE sb.qty_on_hand > 0) AS nearest_expiry
             FROM stock_balance sb LEFT JOIN item_batch b ON b.id = sb.batch_id
            WHERE sb.business_unit_id = bui.business_unit_id AND sb.item_id = bui.item_id
         ) t ON true
        WHERE bui.business_unit_id = $1 AND bui.is_active
        ORDER BY is_low DESC, i.name`, [businessUnitId])).rows);
    res.json(rows);
  });

  router.get('/:businessUnitId/expiring', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { days } = parse(expiringQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT sb.location_id, l.name AS location_name, i.id AS item_id, i.name AS item_name, b.id AS batch_id,
              b.batch_no, b.expiry_date, sb.qty_on_hand, b.expiry_date < current_date AS is_expired
         FROM stock_balance sb
         JOIN item_batch b ON b.id = sb.batch_id
         JOIN item i ON i.id = sb.item_id
         JOIN stock_location l ON l.id = sb.location_id
        WHERE sb.business_unit_id = $1 AND sb.qty_on_hand > 0 AND b.expiry_date <= current_date + $2::int
        ORDER BY b.expiry_date, i.name`, [businessUnitId, days])).rows);
    res.json(rows);
  });

  // The ledger. Unit cost is financial: it is shown only to users with finance read in the unit.
  router.get('/:businessUnitId/movements', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const q = parse(movementQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT m.id::int AS id, m.movement_type, m.item_id, i.sku, i.name AS item_name, m.batch_id, b.batch_no,
              m.from_location_id, fl.name AS from_location_name, m.to_location_id, tl.name AS to_location_name,
              m.qty, CASE WHEN sec.has_scope(m.business_unit_id, 'FIN') THEN m.unit_cost END AS unit_cost,
              m.reason, m.source_doc_type, m.source_doc_id, sec.user_name(m.posted_by) AS posted_by_name, m.posted_at
         FROM stock_movement m
         JOIN item i ON i.id = m.item_id
         LEFT JOIN item_batch b ON b.id = m.batch_id
         LEFT JOIN stock_location fl ON fl.id = m.from_location_id
         LEFT JOIN stock_location tl ON tl.id = m.to_location_id
        WHERE m.business_unit_id = $1
          AND ($2::uuid IS NULL OR m.item_id = $2)
          AND ($3::uuid IS NULL OR $3 IN (m.from_location_id, m.to_location_id))
          AND ($4::bigint IS NULL OR m.id < $4)
        ORDER BY m.id DESC LIMIT $5`,
      [businessUnitId, q.itemId ?? null, q.locationId ?? null, q.beforeId ?? null, q.limit])).rows);
    res.json(rows);
  });

  // All quantity changes go through inv.post_movement, which checks permissions, locks rows and applies FEFO.
  router.post('/:businessUnitId/movements', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(movementSchema, req.body);
    const ids = await req.db(async (c) => (await c.query(
      `SELECT id::int AS id FROM inv.post_movement($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'manual', NULL) AS id`,
      [businessUnitId, b.type, b.itemId, b.qty, b.fromLocationId ?? null, b.toLocationId ?? null, b.batchId ?? null,
       b.batchNo || null, b.expiryDate ?? null, b.mfgDate ?? null, b.unitCost ?? null, b.reason || null])).rows.map((r) => r.id));
    res.status(201).json({ movementIds: ids });
  });

  return router;
}
