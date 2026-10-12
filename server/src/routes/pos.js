import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const ticketParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const catalogQuery = z.object({ locationId: z.uuid().optional() });
const checkoutSchema = z.object({
  departmentId: z.uuid(),
  locationId: z.uuid().nullish(),
  customerId: z.uuid().nullish(),
  discountPct: z.number().min(0).max(100).default(0),
  note: z.string().max(500).nullish(),
  lines: z.array(z.object({ itemId: z.uuid(), qty: z.number().positive().max(1e6) })).min(1).max(200),
  payments: z.array(z.object({
    method: z.enum(['cash', 'card', 'transfer', 'room']),
    amount: z.number().positive().max(1e11),
    reference: z.string().trim().max(80).nullish(),
    reservationId: z.uuid().nullish(),
  })).min(1).max(10),
});
const listQuery = z.object({
  mine: z.enum(['true', 'false']).optional(),
  date: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const voidSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const TICKET_COLUMNS = `t.id, t.ticket_number, t.status, t.department_id, d.name AS department_name, t.location_id,
  t.customer_id, c.full_name AS customer_name, t.seller_id, sec.user_name(t.seller_id) AS seller_name,
  t.subtotal, t.discount_pct, t.discount_amount, t.service_charge_pct, t.service_charge_amount, t.tax_pct, t.tax_amount,
  t.total, t.amount_paid, t.change_due, t.note, t.created_at,
  sec.user_name(t.voided_by) AS voided_by_name, t.voided_at, t.void_reason`;

export function posRoutes() {
  const router = Router();

  // What the till can sell: the unit's priced, sellable items, with stock at the till's store.
  router.get('/:businessUnitId/catalog', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { locationId } = parse(catalogQuery, req.query);
    const data = await req.db(async (c) => ({
      items: (await c.query(
        `SELECT i.id, i.sku, i.name, u.code AS uom, i.is_stockable, bui.sell_price, cat.name AS category_name,
                (SELECT coalesce(sum(qty_on_hand), 0) FROM stock_balance sb WHERE sb.location_id = $2 AND sb.item_id = i.id) AS on_hand
           FROM business_unit_item bui
           JOIN item i ON i.id = bui.item_id AND i.is_active AND i.is_sellable
           JOIN unit_of_measure u ON u.id = i.base_uom_id
           LEFT JOIN item_category cat ON cat.id = i.category_id
          WHERE bui.business_unit_id = $1 AND bui.is_active AND bui.sell_price IS NOT NULL
          ORDER BY cat.name NULLS LAST, i.name`, [businessUnitId, locationId ?? null])).rows,
      rates: (await c.query(
        `SELECT key, value FROM business_unit_setting WHERE business_unit_id = $1
            AND key IN ('charges.service_pct', 'tax.vat_pct', 'pos.max_discount_pct')`, [businessUnitId])).rows
        .reduce((o, r) => ({ ...o, [r.key]: Number(r.value) }), {}),
      departments: (await c.query(
        `SELECT d.id, d.name FROM department d WHERE d.business_unit_id = $1 AND d.is_active AND sec.can_sell($1, d.id)
          ORDER BY d.name`, [businessUnitId])).rows,
    }));
    res.json(data);
  });

  router.post('/:businessUnitId/checkout', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(checkoutSchema, req.body);
    const id = await req.db(async (c) => (await c.query(
      'SELECT pos.checkout($1, $2, $3, $4, $5, $6, $7, $8) AS id',
      [businessUnitId, b.departmentId, b.locationId ?? null, b.customerId ?? null, b.discountPct,
       JSON.stringify(b.lines), JSON.stringify(b.payments), b.note ?? null])).rows[0].id);
    res.status(201).json({ id });
  });

  // Sellers (finance write without configuration write: cashiers, front desk) see their own tickets.
  // Managers, the owner, the partner and read-only viewers (e.g. the owner looking at the Spa) see all.
  const SEES_ALL = `(sec.has_scope($1, 'CFG', true) OR NOT sec.has_scope($1, 'FIN', true))`;
  router.get('/:businessUnitId/tickets', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const q = parse(listQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT ${TICKET_COLUMNS}
         FROM sale_ticket t JOIN department d ON d.id = t.department_id LEFT JOIN customer c ON c.id = t.customer_id
        WHERE t.business_unit_id = $1
          AND (t.seller_id = sec.current_user_id() OR (NOT $2 AND ${SEES_ALL}))
          AND ($3::date IS NULL OR (t.created_at AT TIME ZONE 'Africa/Lagos')::date = $3)
        ORDER BY t.created_at DESC LIMIT $4`,
      [businessUnitId, q.mine === 'true', q.date ?? null, q.limit])).rows);
    res.json(rows);
  });

  router.get('/:businessUnitId/tickets/:id', async (req, res) => {
    const { businessUnitId, id } = parse(ticketParams, req.params);
    const data = await req.db(async (c) => {
      const t = (await c.query(
        `SELECT ${TICKET_COLUMNS}, bu.name AS business_unit_name, bu.currency_code
           FROM sale_ticket t JOIN department d ON d.id = t.department_id LEFT JOIN customer c ON c.id = t.customer_id
           JOIN business_unit bu ON bu.id = t.business_unit_id
          WHERE t.id = $1 AND t.business_unit_id = $2
            AND (t.seller_id = sec.current_user_id() OR ${SEES_ALL.replaceAll('$1', '$2')})`, [id, businessUnitId])).rows[0];
      if (!t) return null;
      t.lines = (await c.query(
        `SELECT l.line_no, i.name AS item_name, i.sku, u.code AS uom, l.qty, l.unit_price, l.line_total,
                CASE WHEN ${SEES_ALL.replaceAll('$1', '$2')} THEN l.cost_amount END AS cost_amount
           FROM sale_line l JOIN item i ON i.id = l.item_id JOIN unit_of_measure u ON u.id = i.base_uom_id
          WHERE l.sale_ticket_id = $1 ORDER BY l.line_no`, [id, businessUnitId])).rows;
      t.payments = (await c.query(
        `SELECT p.method, p.amount, p.reference,
                (SELECT string_agg(rm.room_number, ', ') FROM reservation_room rr JOIN room rm ON rm.id = rr.room_id
                  WHERE rr.reservation_id = p.reservation_id) AS room_numbers
           FROM sale_payment p WHERE p.sale_ticket_id = $1 ORDER BY p.method`, [id])).rows;
      return t;
    });
    if (!data) throw notFound('Ticket not found.');
    res.json(data);
  });

  router.post('/:businessUnitId/tickets/:id/void', async (req, res) => {
    const { id } = parse(ticketParams, req.params);
    const { reason } = parse(voidSchema, req.body);
    await req.db((c) => c.query('SELECT pos.void_ticket($1, $2)', [id, reason]));
    res.status(204).end();
  });

  // Daily summary: takings by method (cash net of change given), voids, best sellers.
  router.get('/:businessUnitId/summary', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { date } = parse(z.object({ date: z.iso.date().optional() }), req.query);
    const data = await req.db(async (c) => {
      const day = date ?? (await c.query(`SELECT (now() AT TIME ZONE 'Africa/Lagos')::date::text AS d`)).rows[0].d;
      const where = `t.business_unit_id = $1 AND (t.created_at AT TIME ZONE 'Africa/Lagos')::date = $2::date
                     AND (t.seller_id = sec.current_user_id() OR ${SEES_ALL})`;
      const totals = (await c.query(
        `SELECT count(*) FILTER (WHERE status = 'completed')::int AS tickets,
                coalesce(sum(total) FILTER (WHERE status = 'completed'), 0) AS gross,
                coalesce(sum(tax_amount) FILTER (WHERE status = 'completed'), 0) AS tax,
                coalesce(sum(service_charge_amount) FILTER (WHERE status = 'completed'), 0) AS service_charge,
                coalesce(sum(discount_amount) FILTER (WHERE status = 'completed'), 0) AS discounts,
                count(*) FILTER (WHERE status = 'voided')::int AS voids,
                coalesce(sum(total) FILTER (WHERE status = 'voided'), 0) AS voided_value
           FROM sale_ticket t WHERE ${where}`, [businessUnitId, day])).rows[0];
      const byMethod = (await c.query(
        `SELECT p.method, sum(p.amount) AS amount
           FROM sale_payment p JOIN sale_ticket t ON t.id = p.sale_ticket_id
          WHERE ${where} AND t.status = 'completed' GROUP BY p.method`, [businessUnitId, day])).rows;
      const change = (await c.query(
        `SELECT coalesce(sum(change_due), 0) AS change FROM sale_ticket t WHERE ${where} AND t.status = 'completed'`,
        [businessUnitId, day])).rows[0].change;
      const top = (await c.query(
        `SELECT i.name, sum(l.qty) AS qty, sum(l.line_total) AS value
           FROM sale_line l JOIN sale_ticket t ON t.id = l.sale_ticket_id JOIN item i ON i.id = l.item_id
          WHERE ${where} AND t.status = 'completed' GROUP BY i.name ORDER BY value DESC LIMIT 10`, [businessUnitId, day])).rows;
      return {
        date: day, ...totals, top,
        byMethod: byMethod.map((m) => ({ method: m.method, amount: Number(m.amount) - (m.method === 'cash' ? Number(change) : 0) })),
      };
    });
    res.json(data);
  });

  return router;
}
