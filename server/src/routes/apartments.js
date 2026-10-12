import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const idParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const roomTypeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/),
  name: z.string().trim().min(2).max(80),
  description: z.string().max(2000).default(''),
  maxAdults: z.int().min(1).max(20).default(2),
  maxChildren: z.int().min(0).max(20).default(0),
  baseRate: z.number().nonnegative().max(1e9),
  amenities: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  isActive: z.boolean().default(true),
});
const roomSchema = z.object({
  roomTypeId: z.uuid(), roomNumber: z.string().trim().min(1).max(20), floor: z.string().trim().max(20).nullish(),
  branchId: z.uuid(), isActive: z.boolean().default(true),
});
const roomPatch = z.object({
  roomTypeId: z.uuid().optional(), roomNumber: z.string().trim().min(1).max(20).optional(),
  floor: z.string().trim().max(20).nullish(), isActive: z.boolean().optional(),
});
const ratePlanSchema = z.object({
  roomTypeId: z.uuid(), name: z.string().trim().min(2).max(80), dateFrom: z.iso.date(), dateTo: z.iso.date(),
  nightlyRate: z.number().nonnegative().max(1e9), priority: z.int().min(1).max(100).default(1),
});
const datesQuery = z.object({ checkIn: z.iso.date(), checkOut: z.iso.date() });
const bookSchema = z.object({
  customerId: z.uuid(),
  source: z.enum(['direct', 'walk_in', 'corporate', 'travel_agent', 'online']).default('direct'),
  checkIn: z.iso.date(), checkOut: z.iso.date(),
  adults: z.int().min(1).max(50).default(1), children: z.int().min(0).max(50).default(0),
  notes: z.string().max(2000).nullish(),
  rooms: z.array(z.object({ roomTypeId: z.uuid(), roomId: z.uuid().nullish() })).min(1).max(20),
});
const listQuery = z.object({
  status: z.string().max(80).optional(), q: z.string().trim().max(80).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
});
const reasonSchema = z.object({ reason: z.string().trim().max(500).nullish() });
const extendSchema = z.object({ checkOut: z.iso.date() });
const folioPostSchema = z.object({
  kind: z.enum(['payment', 'refund', 'charge', 'adjustment']),
  description: z.string().trim().max(200).nullish(),
  amount: z.number().positive().max(1e10),
  method: z.enum(['cash', 'card', 'transfer']).nullish(),
  reference: z.string().trim().max(80).nullish(),
});
const auditSchema = z.object({ through: z.iso.date().optional() });
const statusSchema = z.object({ status: z.enum(['available', 'cleaning', 'maintenance', 'out_of_order']), note: z.string().max(300).nullish() });
const taskSchema = z.object({
  status: z.enum(['open', 'in_progress', 'done']).optional(), assignedTo: z.uuid().nullish(), notes: z.string().max(500).nullish(),
});

const today = `(now() AT TIME ZONE 'Africa/Lagos')::date`;

export function apartmentRoutes() {
  const router = Router();

  // In-house guests for "charge to room" at any till (room numbers and names only).
  router.get('/in-house', async (req, res) => {
    const rows = await req.db(async (c) => (await c.query('SELECT * FROM apt.in_house()')).rows);
    res.json(rows);
  });

  // ---------------- setup ----------------
  router.get('/:businessUnitId/setup', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const data = await req.db(async (c) => ({
      roomTypes: (await c.query(
        `SELECT id, code, name, description, max_adults, max_children, base_rate, amenities, is_active, row_version,
                (SELECT count(*)::int FROM room r WHERE r.room_type_id = t.id AND r.is_active) AS room_count
           FROM room_type t WHERE business_unit_id = $1 ORDER BY base_rate, name`, [businessUnitId])).rows,
      rooms: (await c.query(
        `SELECT r.id, r.room_number, r.floor, r.room_type_id, t.name AS room_type_name, r.status, r.is_active, r.branch_id
           FROM room r JOIN room_type t ON t.id = r.room_type_id WHERE r.business_unit_id = $1
          ORDER BY length(r.room_number), r.room_number`, [businessUnitId])).rows,
      ratePlans: (await c.query(
        `SELECT p.id, p.room_type_id, t.name AS room_type_name, p.name, p.date_from, p.date_to, p.nightly_rate, p.priority
           FROM rate_plan p JOIN room_type t ON t.id = p.room_type_id WHERE p.business_unit_id = $1
          ORDER BY p.date_from DESC`, [businessUnitId])).rows,
    }));
    res.json(data);
  });

  router.post('/:businessUnitId/room-types', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(roomTypeSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO room_type (tenant_id, business_unit_id, code, name, description, max_adults, max_children, base_rate, amenities, is_active)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [businessUnitId, b.code, b.name, b.description, b.maxAdults, b.maxChildren, b.baseRate, b.amenities, b.isActive])).rows[0]);
    res.status(201).json(row);
  });

  router.patch('/:businessUnitId/room-types/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const b = parse(roomTypeSchema.omit({ code: true }).partial(), req.body);
    const row = await req.db(async (c) => (await c.query(
      `UPDATE room_type SET name = coalesce($3, name), description = coalesce($4, description),
              max_adults = coalesce($5, max_adults), max_children = coalesce($6, max_children),
              base_rate = coalesce($7, base_rate), amenities = coalesce($8, amenities), is_active = coalesce($9, is_active)
        WHERE id = $1 AND business_unit_id = $2 RETURNING *`,
      [id, businessUnitId, b.name ?? null, b.description ?? null, b.maxAdults ?? null, b.maxChildren ?? null,
       b.baseRate ?? null, b.amenities ?? null, b.isActive ?? null])).rows[0]);
    if (!row) throw notFound('Room type not found, or you cannot change it.');
    res.json(row);
  });

  router.post('/:businessUnitId/rooms', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(roomSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO room (tenant_id, business_unit_id, branch_id, room_type_id, room_number, floor, is_active)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING *`,
      [businessUnitId, b.branchId, b.roomTypeId, b.roomNumber, b.floor ?? null, b.isActive])).rows[0]);
    res.status(201).json(row);
  });

  router.patch('/:businessUnitId/rooms/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const b = parse(roomPatch, req.body);
    const row = await req.db(async (c) => (await c.query(
      `UPDATE room SET room_type_id = coalesce($3, room_type_id), room_number = coalesce($4, room_number),
              floor = CASE WHEN $5::boolean THEN $6 ELSE floor END, is_active = coalesce($7, is_active)
        WHERE id = $1 AND business_unit_id = $2 RETURNING *`,
      [id, businessUnitId, b.roomTypeId ?? null, b.roomNumber ?? null, b.floor !== undefined, b.floor ?? null, b.isActive ?? null])).rows[0]);
    if (!row) throw notFound('Room not found, or you cannot change it.');
    res.json(row);
  });

  router.post('/:businessUnitId/rate-plans', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(ratePlanSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO rate_plan (tenant_id, business_unit_id, room_type_id, name, date_from, date_to, nightly_rate, priority)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [businessUnitId, b.roomTypeId, b.name, b.dateFrom, b.dateTo, b.nightlyRate, b.priority])).rows[0]);
    res.status(201).json(row);
  });

  router.delete('/:businessUnitId/rate-plans/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const { rowCount } = await req.db((c) => c.query('DELETE FROM rate_plan WHERE id = $1 AND business_unit_id = $2', [id, businessUnitId]));
    if (!rowCount) throw notFound('Rate plan not found, or you cannot change it.');
    res.status(204).end();
  });

  // ---------------- availability & booking ----------------
  // Free rooms per type for the dates, with the price of the stay (rate plans applied per night).
  router.get('/:businessUnitId/availability', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { checkIn, checkOut } = parse(datesQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT t.id AS room_type_id, t.name, t.code, t.max_adults, t.max_children, t.amenities, t.base_rate,
              (SELECT sum(apt.nightly_rate(t.id, d::date)) FROM generate_series($2::date, $3::date - 1, interval '1 day') d) AS stay_total,
              coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'room_number', r.room_number, 'status', r.status)
                                          ORDER BY length(r.room_number), r.room_number)
                          FROM room r
                         WHERE r.room_type_id = t.id AND r.is_active AND r.status <> 'out_of_order'
                           AND NOT EXISTS (SELECT 1 FROM room_night n WHERE n.room_id = r.id AND n.stay_date >= $2 AND n.stay_date < $3)), '[]') AS free_rooms
         FROM room_type t
        WHERE t.business_unit_id = $1 AND t.is_active AND $3::date > $2::date
        ORDER BY t.base_rate`, [businessUnitId, checkIn, checkOut])).rows);
    res.json(rows);
  });

  router.post('/:businessUnitId/reservations', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(bookSchema, req.body);
    const id = await req.db(async (c) => (await c.query(
      'SELECT apt.book($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id',
      [businessUnitId, b.customerId, b.source, b.checkIn, b.checkOut, b.adults, b.children, b.notes ?? null,
       JSON.stringify(b.rooms)])).rows[0].id);
    res.status(201).json({ id });
  });

  const RES_SUMMARY = `
    SELECT r.id, r.booking_ref, r.status, r.source, r.check_in, r.check_out, r.check_out - r.check_in AS nights,
           r.adults, r.children, r.customer_id, c.full_name AS guest_name, c.phone AS guest_phone,
           (SELECT string_agg(rm.room_number, ', ' ORDER BY rm.room_number) FROM reservation_room rr JOIN room rm ON rm.id = rr.room_id
             WHERE rr.reservation_id = r.id) AS rooms,
           CASE WHEN sec.has_scope(r.business_unit_id, 'FIN') THEN apt.folio_balance(f.id) END AS balance
      FROM reservation r JOIN customer c ON c.id = r.customer_id LEFT JOIN folio f ON f.reservation_id = r.id`;

  router.get('/:businessUnitId/reservations', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const q = parse(listQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `${RES_SUMMARY}
        WHERE r.business_unit_id = $1
          AND ($2::text IS NULL OR r.status::text = ANY (string_to_array($2, ',')))
          AND ($3::text IS NULL OR c.full_name ILIKE '%' || $3 || '%' OR r.booking_ref ILIKE '%' || $3 || '%')
          AND ($4::date IS NULL OR r.check_out > $4) AND ($5::date IS NULL OR r.check_in <= $5)
        ORDER BY r.check_in, r.booking_ref LIMIT 300`,
      [businessUnitId, q.status ?? null, q.q || null, q.from ?? null, q.to ?? null])).rows);
    res.json(rows);
  });

  router.get('/:businessUnitId/reservations/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const data = await req.db(async (c) => {
      const r = (await c.query(`${RES_SUMMARY} WHERE r.id = $1 AND r.business_unit_id = $2`, [id, businessUnitId])).rows[0];
      if (!r) return null;
      const extra = (await c.query(
        `SELECT r.notes, sec.user_name(r.created_by) AS created_by_name, r.created_at,
                sec.user_name(r.checked_in_by) AS checked_in_by_name, r.checked_in_at,
                sec.user_name(r.checked_out_by) AS checked_out_by_name, r.checked_out_at,
                sec.user_name(r.cancelled_by) AS cancelled_by_name, r.cancelled_at, r.cancel_reason
           FROM reservation r WHERE r.id = $1`, [id])).rows[0];
      const rooms = (await c.query(
        `SELECT rr.id, rm.id AS room_id, rm.room_number, rm.status AS room_status, t.name AS room_type_name,
                (SELECT jsonb_agg(jsonb_build_object('date', n.stay_date, 'rate', n.rate, 'charged', n.charged_entry_id IS NOT NULL)
                                  ORDER BY n.stay_date) FROM room_night n WHERE n.reservation_room_id = rr.id) AS nights
           FROM reservation_room rr JOIN room rm ON rm.id = rr.room_id JOIN room_type t ON t.id = rr.room_type_id
          WHERE rr.reservation_id = $1 ORDER BY rm.room_number`, [id])).rows;
      const folio = (await c.query('SELECT id, folio_number, status, created_at, closed_at FROM folio WHERE reservation_id = $1', [id])).rows[0] ?? null;
      if (folio) {
        folio.entries = (await c.query(
          `SELECT e.id::int AS id, e.entry_type, e.description, e.amount, e.method, e.reference, e.stay_date,
                  sb.name AS source_unit_name, sec.user_name(e.posted_by) AS posted_by_name, e.posted_at
             FROM folio_entry e LEFT JOIN business_unit sb ON sb.id = e.source_business_unit_id
            WHERE e.folio_id = $1 ORDER BY e.id`, [folio.id])).rows;
        folio.balance = folio.entries.reduce((s, e) => s + Number(e.amount), 0);
      }
      return { ...r, ...extra, rooms, folio };
    });
    if (!data) throw notFound('Reservation not found.');
    res.json(data);
  });

  for (const [action, fn] of [['check-in', 'apt.check_in($1)'], ['check-out', 'apt.check_out($1)']]) {
    router.post(`/:businessUnitId/reservations/:id/${action}`, async (req, res) => {
      const { id } = parse(idParams, req.params);
      await req.db((c) => c.query(`SELECT ${fn}`, [id]));
      res.status(204).end();
    });
  }
  for (const [action, status] of [['cancel', 'cancelled'], ['no-show', 'no_show']]) {
    router.post(`/:businessUnitId/reservations/:id/${action}`, async (req, res) => {
      const { id } = parse(idParams, req.params);
      const { reason } = parse(reasonSchema, req.body ?? {});
      await req.db((c) => c.query('SELECT apt.cancel($1, $2, $3)', [id, status, reason ?? null]));
      res.status(204).end();
    });
  }
  router.post('/:businessUnitId/reservations/:id/extend', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const { checkOut } = parse(extendSchema, req.body);
    await req.db((c) => c.query('SELECT apt.extend($1, $2)', [id, checkOut]));
    res.status(204).end();
  });

  router.post('/:businessUnitId/folios/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(folioPostSchema, req.body);
    const entryId = await req.db(async (c) => (await c.query(
      'SELECT apt.folio_post($1, $2, $3, $4, $5, $6) AS id',
      [id, b.kind, b.description ?? null, b.amount, b.method ?? null, b.reference ?? null])).rows[0].id);
    res.status(201).json({ id: Number(entryId) });
  });

  // ---------------- front desk overview ----------------
  router.post('/:businessUnitId/night-audit', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { through } = parse(auditSchema, req.body ?? {});
    const count = await req.db(async (c) => (await c.query(
      `SELECT apt.post_room_charges($1, coalesce($2::date, ${today})) AS n`, [businessUnitId, through ?? null])).rows[0].n);
    res.json({ nightsCharged: count });
  });

  router.get('/:businessUnitId/today', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const data = await req.db(async (c) => {
      const d = (await c.query(`SELECT ${today}::text AS d`)).rows[0].d;
      const list = async (where) => (await c.query(`${RES_SUMMARY} WHERE r.business_unit_id = $1 AND ${where} ORDER BY c.full_name`,
        where.includes('$2') ? [businessUnitId, d] : [businessUnitId])).rows;
      return {
        date: d,
        arrivals: await list(`r.status = 'confirmed' AND r.check_in <= $2::date AND r.check_out > $2::date`),
        departures: await list(`r.status = 'checked_in' AND r.check_out <= $2::date`),
        inHouse: await list(`r.status = 'checked_in'`),
        rooms: (await c.query(`SELECT status, count(*)::int AS n FROM room WHERE business_unit_id = $1 AND is_active GROUP BY status`,
          [businessUnitId])).rows,
      };
    });
    res.json(data);
  });

  // Room board: every room with its status and who is in it (or arriving) today.
  router.get('/:businessUnitId/board', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT rm.id, rm.room_number, rm.floor, rm.status, rm.status_note, t.name AS room_type_name,
              g.reservation_id, g.booking_ref, g.guest_name, g.check_in, g.check_out, g.res_status
         FROM room rm JOIN room_type t ON t.id = rm.room_type_id
         LEFT JOIN LATERAL (
           SELECT r.id AS reservation_id, r.booking_ref, c.full_name AS guest_name, r.check_in, r.check_out, r.status AS res_status
             FROM room_night n JOIN reservation_room rr ON rr.id = n.reservation_room_id
             JOIN reservation r ON r.id = rr.reservation_id JOIN customer c ON c.id = r.customer_id
            WHERE n.room_id = rm.id AND n.stay_date = ${today} AND r.status IN ('confirmed', 'checked_in')
            LIMIT 1) g ON true
        WHERE rm.business_unit_id = $1 AND rm.is_active
        ORDER BY rm.floor NULLS LAST, length(rm.room_number), rm.room_number`, [businessUnitId])).rows);
    res.json(rows);
  });

  router.post('/:businessUnitId/rooms/:id/status', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(statusSchema, req.body);
    await req.db((c) => c.query('SELECT apt.set_room_status($1, $2, $3)', [id, b.status, b.note ?? null]));
    res.status(204).end();
  });

  router.get('/:businessUnitId/housekeeping', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT h.id, h.task_type, h.status, h.notes, h.created_at, h.done_at, rm.room_number, rm.status AS room_status,
              h.assigned_to, sec.user_name(h.assigned_to) AS assigned_to_name, sec.user_name(h.done_by) AS done_by_name,
              h.assigned_to = sec.current_user_id() AS is_mine
         FROM housekeeping_task h JOIN room rm ON rm.id = h.room_id
        WHERE h.business_unit_id = $1 AND (h.status <> 'done' OR h.done_at > now() - interval '1 day')
        ORDER BY (h.status = 'done'), h.created_at`, [businessUnitId])).rows);
    res.json(rows);
  });

  router.post('/:businessUnitId/housekeeping/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(taskSchema, req.body);
    await req.db(async (c) => {
      const current = (await c.query('SELECT assigned_to FROM housekeeping_task WHERE id = $1', [id])).rows[0];
      if (!current) throw notFound('Task not found.');
      await c.query('SELECT apt.task_update($1, $2, $3, $4)',
        [id, b.status ?? null, b.assignedTo === undefined ? current.assigned_to : b.assignedTo, b.notes ?? null]);
    });
    res.status(204).end();
  });

  return router;
}
