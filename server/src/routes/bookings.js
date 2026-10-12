import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/errors.js';

const unitParam = z.object({ businessUnitId: z.uuid() });
const idParams = z.object({ businessUnitId: z.uuid(), id: z.uuid() });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'use HH:MM');
const hoursSchema = z.array(z.object({ weekday: z.int().min(1).max(7), opens: time, closes: time })).max(70);
const resourceSchema = z.object({
  kind: z.enum(['staff', 'room', 'booth', 'equipment']),
  name: z.string().trim().min(2).max(80),
  userId: z.uuid().nullish(),
  hours: hoursSchema.optional(),
});
const resourcePatch = z.object({
  name: z.string().trim().min(2).max(80).optional(), userId: z.uuid().nullish(), isActive: z.boolean().optional(),
});
const roleName = z.string().trim().toLowerCase().regex(/^[a-z][a-z ]{1,29}$/, 'roles are 2–30 letters');
const serviceResources = z.array(z.object({ resourceId: z.uuid(), role: roleName })).max(100);
const serviceFields = {
  name: z.string().trim().min(2).max(80),
  description: z.string().max(2000),
  durationMin: z.int().min(5).max(720).multipleOf(5),
  bufferMin: z.int().min(0).max(240).multipleOf(5),
  minSlots: z.int().min(1).max(48),
  maxSlots: z.int().min(1).max(48),
  price: z.number().nonnegative().max(1e9),
  onlineBookable: z.boolean(),
  isActive: z.boolean(),
};
const serviceSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/),
  mode: z.enum(['service', 'slot']),
  ...serviceFields,
  description: serviceFields.description.default(''),
  bufferMin: serviceFields.bufferMin.default(0),
  minSlots: serviceFields.minSlots.default(1),
  maxSlots: serviceFields.maxSlots.default(1),
  onlineBookable: serviceFields.onlineBookable.default(false),
  isActive: serviceFields.isActive.default(true),
  resources: serviceResources.default([]),
});
const servicePatch = z.object({
  ...Object.fromEntries(Object.entries(serviceFields).map(([k, v]) => [k, v.optional()])),
  resources: serviceResources.optional(),
});
const preferred = z.record(roleName, z.uuid()).default({});
const availabilityQuery = z.object({
  serviceId: z.uuid(), date: z.iso.date(), slots: z.coerce.number().int().min(1).max(48).optional(),
  preferred: z.string().max(2000).optional(), except: z.uuid().optional(),
});
const bookSchema = z.object({
  serviceId: z.uuid(), customerId: z.uuid(), startsAt: z.iso.datetime({ offset: true }),
  slots: z.int().min(1).max(48).nullish(),
  source: z.enum(['direct', 'walk_in', 'phone', 'online']).default('direct'),
  notes: z.string().max(2000).nullish(),
  preferred,
});
const rescheduleSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }), slots: z.int().min(1).max(48).nullish(), preferred,
});
const reasonSchema = z.object({ reason: z.string().trim().max(500).nullish() });
const blockSchema = z.object({
  from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }), reason: z.string().trim().min(2).max(200),
});
const dayQuery = z.object({ date: z.iso.date() });
const listQuery = z.object({
  status: z.string().max(80).optional(), q: z.string().trim().max(80).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
});

const parsePreferred = (raw) => {
  if (!raw) return {};
  try {
    return parse(preferred, JSON.parse(raw));
  } catch (err) {
    if (err instanceof SyntaxError) throw badRequest('preferred must be JSON');
    throw err;
  }
};

const APPT_SUMMARY = `
  SELECT a.id, a.booking_ref, a.status, a.source, a.starts_at, a.ends_at, a.slots, a.price, a.notes,
         a.service_id, s.name AS service_name, s.mode, a.customer_id, c.full_name AS guest_name, c.phone AS guest_phone,
         (SELECT jsonb_agg(jsonb_build_object('resourceId', r.id, 'name', r.name, 'role', ar.role, 'kind', r.kind) ORDER BY ar.role)
            FROM appointment_resource ar JOIN bookable_resource r ON r.id = ar.resource_id
           WHERE ar.appointment_id = a.id AND (ar.is_active OR a.status IN ('cancelled', 'no_show'))) AS resources
    FROM appointment a JOIN bookable_service s ON s.id = a.service_id JOIN customer c ON c.id = a.customer_id`;

// Local-day boundaries in the unit's time zone, as SQL taking ($1 = unit, $2 = date).
const DAY_RANGE = `tstzrange(($2::date)::timestamp AT TIME ZONE (SELECT time_zone FROM business_unit WHERE id = $1),
                             ($2::date + 1)::timestamp AT TIME ZONE (SELECT time_zone FROM business_unit WHERE id = $1))`;

export function bookingRoutes() {
  const router = Router();

  // ---------------- setup ----------------
  router.get('/:businessUnitId/setup', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const data = await req.db(async (c) => ({
      timeZone: (await c.query('SELECT time_zone FROM business_unit WHERE id = $1', [businessUnitId])).rows[0]?.time_zone,
      resources: (await c.query(
        `SELECT r.id, r.kind, r.name, r.user_id, sec.user_name(r.user_id) AS user_name, r.is_active,
                coalesce((SELECT jsonb_agg(jsonb_build_object('weekday', h.weekday, 'opens', to_char(h.opens, 'HH24:MI'),
                                                              'closes', CASE WHEN h.closes = '24:00' THEN '24:00' ELSE to_char(h.closes, 'HH24:MI') END)
                                           ORDER BY h.weekday, h.opens)
                            FROM resource_hours h WHERE h.resource_id = r.id), '[]') AS hours
           FROM bookable_resource r WHERE r.business_unit_id = $1 ORDER BY r.kind, r.name`, [businessUnitId])).rows,
      services: (await c.query(
        `SELECT s.id, s.code, s.name, s.description, s.mode, s.duration_min, s.buffer_min, s.min_slots, s.max_slots,
                s.price, s.online_bookable, s.is_active,
                coalesce((SELECT jsonb_agg(jsonb_build_object('resourceId', sr.resource_id, 'role', sr.role) ORDER BY sr.role)
                            FROM service_resource sr WHERE sr.service_id = s.id), '[]') AS resources
           FROM bookable_service s WHERE s.business_unit_id = $1 ORDER BY s.name`, [businessUnitId])).rows,
    }));
    res.json(data);
  });

  router.get('/:businessUnitId/people', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    res.json(await req.db(async (c) => (await c.query('SELECT * FROM bk.unit_people($1)', [businessUnitId])).rows));
  });

  router.post('/:businessUnitId/resources', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(resourceSchema, req.body);
    const row = await req.db(async (c) => {
      const r = (await c.query(
        `INSERT INTO bookable_resource (tenant_id, business_unit_id, kind, name, user_id)
         VALUES (sec.current_tenant_id(), $1, $2, $3, $4) RETURNING id, kind, name, user_id, is_active`,
        [businessUnitId, b.kind, b.name, b.userId ?? null])).rows[0];
      if (b.hours) await c.query('SELECT bk.set_hours($1, $2)', [r.id, JSON.stringify(b.hours)]);
      return r;
    });
    res.status(201).json(row);
  });

  router.patch('/:businessUnitId/resources/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const b = parse(resourcePatch, req.body);
    const n = await req.db(async (c) => (await c.query(
      `UPDATE bookable_resource SET name = coalesce($3, name),
              user_id = CASE WHEN $4::boolean THEN $5::uuid ELSE user_id END, is_active = coalesce($6, is_active)
        WHERE id = $1 AND business_unit_id = $2`,
      [id, businessUnitId, b.name ?? null, 'userId' in b, b.userId ?? null, b.isActive ?? null])).rowCount);
    if (!n) throw notFound('Resource not found.');
    res.status(204).end();
  });

  router.put('/:businessUnitId/resources/:id/hours', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const hours = parse(z.object({ hours: hoursSchema }), req.body).hours;
    await req.db((c) => c.query('SELECT bk.set_hours($1, $2)', [id, JSON.stringify(hours)]));
    res.status(204).end();
  });

  router.post('/:businessUnitId/resources/:id/blocks', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const b = parse(blockSchema, req.body);
    const blockId = await req.db(async (c) => (await c.query(
      'SELECT bk.add_block($1, $2, $3, $4) AS id', [id, b.from, b.to, b.reason])).rows[0].id);
    res.status(201).json({ id: blockId });
  });

  router.delete('/:businessUnitId/blocks/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const n = await req.db(async (c) => (await c.query(
      'DELETE FROM resource_block WHERE id = $1 AND business_unit_id = $2', [id, businessUnitId])).rowCount);
    if (!n) throw notFound('Block not found.');
    res.status(204).end();
  });

  const saveServiceResources = async (c, serviceId, businessUnitId, resources) => {
    await c.query('DELETE FROM service_resource WHERE service_id = $1', [serviceId]);
    for (const r of resources) {
      await c.query(`INSERT INTO service_resource (tenant_id, service_id, resource_id, business_unit_id, role)
                      VALUES (sec.current_tenant_id(), $1, $2, $3, $4)`,
        [serviceId, r.resourceId, businessUnitId, r.role]);
    }
  };

  router.post('/:businessUnitId/services', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(serviceSchema, req.body);
    const row = await req.db(async (c) => {
      const s = (await c.query(
        `INSERT INTO bookable_service (tenant_id, business_unit_id, code, name, description, mode, duration_min, buffer_min,
                                       min_slots, max_slots, price, online_bookable, is_active)
         VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, code, name, mode`,
        [businessUnitId, b.code, b.name, b.description, b.mode, b.durationMin, b.bufferMin,
          b.mode === 'slot' ? b.minSlots : 1, b.mode === 'slot' ? b.maxSlots : 1, b.price, b.onlineBookable, b.isActive])).rows[0];
      await saveServiceResources(c, s.id, businessUnitId, b.resources);
      return s;
    });
    res.status(201).json(row);
  });

  router.patch('/:businessUnitId/services/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const b = parse(servicePatch, req.body);
    await req.db(async (c) => {
      const n = (await c.query(
        `UPDATE bookable_service SET name = coalesce($3, name), description = coalesce($4, description),
                duration_min = coalesce($5, duration_min), buffer_min = coalesce($6, buffer_min),
                min_slots = CASE WHEN mode = 'slot' THEN coalesce($7, min_slots) ELSE 1 END,
                max_slots = CASE WHEN mode = 'slot' THEN coalesce($8, max_slots) ELSE 1 END,
                price = coalesce($9, price), online_bookable = coalesce($10, online_bookable), is_active = coalesce($11, is_active)
          WHERE id = $1 AND business_unit_id = $2`,
        [id, businessUnitId, b.name ?? null, b.description ?? null, b.durationMin ?? null, b.bufferMin ?? null,
          b.minSlots ?? null, b.maxSlots ?? null, b.price ?? null, b.onlineBookable ?? null, b.isActive ?? null])).rowCount;
      if (!n) throw notFound('Service not found.');
      if (b.resources) await saveServiceResources(c, id, businessUnitId, b.resources);
    });
    res.status(204).end();
  });

  // ---------------- availability and the day view ----------------
  router.get('/:businessUnitId/availability', async (req, res) => {
    const q = parse(availabilityQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      'SELECT * FROM bk.availability($1, $2, $3, $4, $5)',
      [q.serviceId, q.date, q.slots ?? null, JSON.stringify(parsePreferred(q.preferred)), q.except ?? null])).rows);
    res.json(rows);
  });

  // One local day: each resource with its hours, blocks and bookings.
  router.get('/:businessUnitId/day', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const { date } = parse(dayQuery, req.query);
    const data = await req.db(async (c) => {
      const resources = (await c.query(
        `SELECT r.id, r.kind, r.name, r.user_id = sec.current_user_id() AS is_me,
                coalesce((SELECT jsonb_agg(jsonb_build_object('opens', to_char(h.opens, 'HH24:MI'),
                                  'closes', CASE WHEN h.closes = '24:00' THEN '24:00' ELSE to_char(h.closes, 'HH24:MI') END) ORDER BY h.opens)
                            FROM resource_hours h WHERE h.resource_id = r.id AND h.weekday = extract(isodow FROM $2::date)), '[]') AS hours,
                coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'from', lower(b.during), 'to', upper(b.during), 'reason', b.reason)
                                           ORDER BY lower(b.during))
                            FROM resource_block b WHERE b.resource_id = r.id AND b.during && ${DAY_RANGE}), '[]') AS blocks
           FROM bookable_resource r WHERE r.business_unit_id = $1 AND r.is_active ORDER BY r.kind, r.name`,
        [businessUnitId, date])).rows;
      const appointments = (await c.query(
        `${APPT_SUMMARY} WHERE a.business_unit_id = $1 AND tstzrange(a.starts_at, a.ends_at) && ${DAY_RANGE}
           AND a.status NOT IN ('cancelled') ORDER BY a.starts_at`, [businessUnitId, date])).rows;
      const tz = (await c.query('SELECT time_zone FROM business_unit WHERE id = $1', [businessUnitId])).rows[0]?.time_zone;
      return { date, timeZone: tz, resources, appointments };
    });
    res.json(data);
  });

  // ---------------- appointments ----------------
  router.get('/:businessUnitId/appointments', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const q = parse(listQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `${APPT_SUMMARY}
        WHERE a.business_unit_id = $1
          AND ($2::text IS NULL OR a.status::text = ANY (string_to_array($2, ',')))
          AND ($3::text IS NULL OR c.full_name ILIKE '%' || $3 || '%' OR a.booking_ref ILIKE '%' || $3 || '%' OR c.phone ILIKE '%' || $3 || '%')
          AND ($4::date IS NULL OR a.starts_at >= ($4::date)::timestamp AT TIME ZONE (SELECT time_zone FROM business_unit WHERE id = $1))
          AND ($5::date IS NULL OR a.starts_at < ($5::date + 1)::timestamp AT TIME ZONE (SELECT time_zone FROM business_unit WHERE id = $1))
        ORDER BY a.starts_at, a.booking_ref LIMIT 300`,
      [businessUnitId, q.status ?? null, q.q || null, q.from ?? null, q.to ?? null])).rows);
    res.json(rows);
  });

  router.get('/:businessUnitId/appointments/:id', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const data = await req.db(async (c) => {
      const a = (await c.query(`${APPT_SUMMARY} WHERE a.id = $1 AND a.business_unit_id = $2`, [id, businessUnitId])).rows[0];
      if (!a) return null;
      const extra = (await c.query(
        `SELECT s.duration_min, s.buffer_min, s.min_slots, s.max_slots, bu.time_zone,
                sec.user_name(a.created_by) AS created_by_name, a.created_at,
                sec.user_name(a.checked_in_by) AS checked_in_by_name, a.checked_in_at,
                sec.user_name(a.completed_by) AS completed_by_name, a.completed_at,
                sec.user_name(a.cancelled_by) AS cancelled_by_name, a.cancelled_at, a.cancel_reason
           FROM appointment a JOIN bookable_service s ON s.id = a.service_id JOIN business_unit bu ON bu.id = a.business_unit_id
          WHERE a.id = $1`, [id])).rows[0];
      return { ...a, ...extra };
    });
    if (!data) throw notFound('Appointment not found.');
    res.json(data);
  });

  router.post('/:businessUnitId/appointments', async (req, res) => {
    const { businessUnitId } = parse(unitParam, req.params);
    const b = parse(bookSchema, req.body);
    const id = await req.db(async (c) => {
      const s = (await c.query('SELECT business_unit_id FROM bookable_service WHERE id = $1', [b.serviceId])).rows[0];
      if (!s || s.business_unit_id !== businessUnitId) throw notFound('Service not found.');
      return (await c.query('SELECT bk.book($1, $2, $3, $4, $5, $6, $7) AS id',
        [b.serviceId, b.customerId, b.startsAt, b.slots ?? null, b.source, b.notes ?? null, JSON.stringify(b.preferred)])).rows[0].id;
    });
    res.status(201).json({ id });
  });

  const inUnit = async (c, id, businessUnitId) => {
    const a = (await c.query('SELECT 1 FROM appointment WHERE id = $1 AND business_unit_id = $2', [id, businessUnitId])).rows[0];
    if (!a) throw notFound('Appointment not found.');
  };

  router.post('/:businessUnitId/appointments/:id/reschedule', async (req, res) => {
    const { businessUnitId, id } = parse(idParams, req.params);
    const b = parse(rescheduleSchema, req.body);
    await req.db(async (c) => {
      await inUnit(c, id, businessUnitId);
      await c.query('SELECT bk.reschedule($1, $2, $3, $4)', [id, b.startsAt, b.slots ?? null, JSON.stringify(b.preferred)]);
    });
    res.status(204).end();
  });

  for (const [path, sql] of [['check-in', 'SELECT bk.check_in($1)'], ['complete', 'SELECT bk.complete($1)']]) {
    router.post(`/:businessUnitId/appointments/:id/${path}`, async (req, res) => {
      const { businessUnitId, id } = parse(idParams, req.params);
      await req.db(async (c) => { await inUnit(c, id, businessUnitId); await c.query(sql, [id]); });
      res.status(204).end();
    });
  }

  for (const [path, action] of [['cancel', 'cancelled'], ['no-show', 'no_show']]) {
    router.post(`/:businessUnitId/appointments/:id/${path}`, async (req, res) => {
      const { businessUnitId, id } = parse(idParams, req.params);
      const { reason } = parse(reasonSchema, req.body ?? {});
      await req.db(async (c) => {
        await inUnit(c, id, businessUnitId);
        await c.query('SELECT bk.cancel($1, $2, $3)', [id, action, reason ?? null]);
      });
      res.status(204).end();
    });
  }

  return router;
}
