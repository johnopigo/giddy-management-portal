import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const poParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const draftSchema = z.object({
  supplierId: z.uuid(),
  expectedDate: z.iso.date().nullish(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(z.object({
    itemId: z.uuid(),
    qty: z.number().positive().max(1e9),
    unitCost: z.number().nonnegative().max(1e11),
  })).min(1).max(200),
});
const noteSchema = z.object({ note: z.string().trim().max(500).nullish() });
const receiveSchema = z.object({
  locationId: z.uuid(),
  supplierInvoiceRef: z.string().trim().max(60).nullish(),
  notes: z.string().max(1000).nullish(),
  lines: z.array(z.object({
    poLineId: z.uuid(),
    qty: z.number().nonnegative().max(1e9),
    batchNo: z.string().trim().max(60).nullish(),
    expiryDate: z.iso.date().nullish(),
  })).min(1).max(200),
});
const listQuery = z.object({ status: z.string().max(40).optional() });

export function procurementRoutes() {
  const router = Router();

  router.get('/:businessUnitId/purchase-orders', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { status } = parse(listQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT po.id, po.po_number, po.status, po.supplier_id, s.name AS supplier_name, po.expected_date, po.created_at,
              sec.user_name(po.created_by) AS created_by_name, po.approved_at,
              (SELECT coalesce(sum(qty_ordered * unit_cost), 0) FROM purchase_order_line WHERE purchase_order_id = po.id) AS total,
              (SELECT count(*)::int FROM purchase_order_line WHERE purchase_order_id = po.id) AS line_count
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id
        WHERE po.business_unit_id = $1 AND ($2::text IS NULL OR po.status::text = ANY (string_to_array($2, ',')))
        ORDER BY po.created_at DESC LIMIT 200`, [businessUnitId, status ?? null])).rows);
    res.json(rows);
  });

  router.get('/:businessUnitId/purchase-orders/:id', async (req, res) => {
    const { businessUnitId, id } = parse(poParams, req.params);
    const data = await req.db(async (c) => {
      const po = (await c.query(
        `SELECT po.*, s.name AS supplier_name, sec.user_name(po.created_by) AS created_by_name,
                sec.user_name(po.submitted_by) AS submitted_by_name, sec.user_name(po.approved_by) AS approved_by_name,
                sec.user_name(po.closed_by) AS closed_by_name
           FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id
          WHERE po.id = $1 AND po.business_unit_id = $2`, [id, businessUnitId])).rows[0];
      if (!po) return null;
      po.lines = (await c.query(
        `SELECT l.id, l.line_no, l.item_id, i.sku, i.name AS item_name, u.code AS uom, i.is_batch_tracked, i.is_expiry_tracked,
                l.qty_ordered, l.unit_cost, l.qty_received, l.qty_ordered * l.unit_cost AS line_total
           FROM purchase_order_line l JOIN item i ON i.id = l.item_id JOIN unit_of_measure u ON u.id = i.base_uom_id
          WHERE l.purchase_order_id = $1 ORDER BY l.line_no`, [id])).rows;
      po.receipts = (await c.query(
        `SELECT g.id, g.receipt_number, g.received_at, sec.user_name(g.received_by) AS received_by_name,
                g.supplier_invoice_ref, sl.name AS location_name,
                (SELECT jsonb_agg(jsonb_build_object('item_name', i.name, 'qty', gl.qty, 'batch_no', gl.batch_no,
                                                     'expiry_date', gl.expiry_date) ORDER BY i.name)
                   FROM goods_receipt_line gl JOIN item i ON i.id = gl.item_id WHERE gl.goods_receipt_id = g.id) AS lines
           FROM goods_receipt g JOIN stock_location sl ON sl.id = g.location_id
          WHERE g.purchase_order_id = $1 ORDER BY g.received_at`, [id])).rows;
      po.total = po.lines.reduce((s, l) => s + Number(l.line_total), 0);
      return po;
    });
    if (!data) throw notFound('Purchase order not found.');
    res.json(data);
  });

  const saveDraft = async (req, res, id) => {
    const { businessUnitId } = parse(unitParam, { businessUnitId: req.params.businessUnitId });
    const b = parse(draftSchema, req.body);
    const poId = await req.db(async (c) => (await c.query(
      'SELECT inv.po_save_draft($1, $2, $3, $4, $5, $6) AS id',
      [id, businessUnitId, b.supplierId, b.expectedDate ?? null, b.notes ?? null, JSON.stringify(b.lines)])).rows[0].id);
    res.status(id ? 200 : 201).json({ id: poId });
  };
  router.post('/:businessUnitId/purchase-orders', (req, res) => saveDraft(req, res, null));
  router.put('/:businessUnitId/purchase-orders/:id', (req, res) => saveDraft(req, res, parse(poParams, req.params).id));

  for (const action of ['submit', 'approve', 'reject', 'cancel', 'close']) {
    router.post(`/:businessUnitId/purchase-orders/:id/${action}`, async (req, res) => {
      const { id } = parse(poParams, req.params);
      const { note } = parse(noteSchema, req.body ?? {});
      await req.db((c) => c.query('SELECT inv.po_transition($1, $2, $3)', [id, action, note ?? null]));
      res.status(204).end();
    });
  }

  router.post('/:businessUnitId/purchase-orders/:id/receive', async (req, res) => {
    const { id } = parse(poParams, req.params);
    const b = parse(receiveSchema, req.body);
    const receiptId = await req.db(async (c) => (await c.query(
      'SELECT inv.po_receive($1, $2, $3, $4, $5) AS id',
      [id, b.locationId, b.supplierInvoiceRef ?? null, b.notes ?? null, JSON.stringify(b.lines)])).rows[0].id);
    res.status(201).json({ id: receiptId });
  });

  // Items at or below their reorder level, with a suggested quantity and the last price paid.
  router.get('/:businessUnitId/reorder-suggestions', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `WITH stock AS (
         SELECT item_id, sum(qty_on_hand) AS on_hand FROM stock_balance WHERE business_unit_id = $1 GROUP BY item_id)
       SELECT i.id AS item_id, i.sku, i.name AS item_name, u.code AS uom, coalesce(s.on_hand, 0) AS on_hand,
              bui.reorder_level, bui.reorder_qty,
              greatest(bui.reorder_qty, bui.reorder_level * 2 - coalesce(s.on_hand, 0)) AS suggested_qty,
              last.unit_cost AS last_unit_cost, last.supplier_id AS last_supplier_id, last.supplier_name AS last_supplier_name
         FROM business_unit_item bui
         JOIN item i ON i.id = bui.item_id AND i.is_active AND i.is_stockable
         JOIN unit_of_measure u ON u.id = i.base_uom_id
         LEFT JOIN stock s ON s.item_id = i.id
         LEFT JOIN LATERAL (
           SELECT l.unit_cost, po.supplier_id, sp.name AS supplier_name
             FROM purchase_order_line l JOIN purchase_order po ON po.id = l.purchase_order_id
             JOIN supplier sp ON sp.id = po.supplier_id
            WHERE po.business_unit_id = $1 AND l.item_id = i.id AND po.status NOT IN ('draft', 'cancelled')
            ORDER BY po.created_at DESC LIMIT 1) last ON true
        WHERE bui.business_unit_id = $1 AND bui.is_active AND bui.reorder_level > 0
          AND coalesce(s.on_hand, 0) <= bui.reorder_level
        ORDER BY i.name`, [businessUnitId])).rows);
    res.json(rows);
  });

  return router;
}
