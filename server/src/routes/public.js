import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { parse } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/errors.js';
import { withContext } from '../db/context.js';
import { hashToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { gateway, gatewayName } from '../payments/gateway.js';

// ---------------------------------------------------------------------------------------------
// Public booking pages. Nothing here needs a login: each request is resolved to a tenant by its
// public address (or a booking's secret link) and runs as that tenant's "Online booking" system
// account, so the booking engines apply the same rules as for staff.
// ---------------------------------------------------------------------------------------------

const slugParam = z.object({ slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,40}$/) });
const unitParams = slugParam.extend({ unitId: z.uuid() });
const tokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{40,60}$/) });
const guestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.email().max(200),
});
const roomQuery = z.object({ unitId: z.uuid(), checkIn: z.iso.date(), checkOut: z.iso.date(), adults: z.coerce.number().int().min(1).max(20).default(1) });
const roomBooking = z.object({
  unitId: z.uuid(), roomTypeId: z.uuid(), checkIn: z.iso.date(), checkOut: z.iso.date(),
  adults: z.int().min(1).max(20).default(1), children: z.int().min(0).max(20).default(0),
  notes: z.string().trim().max(1000).nullish(), guest: guestSchema,
});
const slotQuery = z.object({ serviceId: z.uuid(), date: z.iso.date(), slots: z.coerce.number().int().min(1).max(48).optional() });
const appointmentBooking = z.object({
  serviceId: z.uuid(), startsAt: z.iso.datetime({ offset: true }), slots: z.int().min(1).max(48).nullish(),
  notes: z.string().trim().max(1000).nullish(), guest: guestSchema,
});
const verifySchema = z.object({ reference: z.string().trim().min(6).max(100) });
const outcomeSchema = z.object({ outcome: z.enum(['success', 'failed']) });

const ctx = (req, t) => ({ userId: t.agent_id, tenantId: t.tenant_id, correlationId: req.correlationId, ip: req.ip });

async function resolveSlug(req) {
  const { slug } = parse(slugParam, req.params);
  const t = (await withContext({ correlationId: req.correlationId }, (c) => c.query('SELECT * FROM web.resolve($1)', [slug]))).rows[0];
  if (!t?.tenant_id || !t.agent_id) throw notFound('Booking page not found.');
  return t;
}

async function resolveToken(req) {
  const { token } = parse(tokenParam, req.params);
  const t = (await withContext({ correlationId: req.correlationId },
    (c) => c.query('SELECT * FROM web.resolve_booking($1, NULL)', [hashToken(token)]))).rows[0];
  if (!t?.tenant_id) throw notFound('Booking not found. Check the link you were given.');
  return t;
}

const enabled = (c, unitId) => c.query(
  `SELECT bu.id, bu.name, bu.unit_type, bu.time_zone FROM business_unit bu
    WHERE bu.id = $1 AND bu.tenant_id = sec.current_tenant_id() AND bu.is_active
      AND (SELECT value FROM business_unit_setting WHERE business_unit_id = bu.id AND key = 'online.enabled') = 'true'::jsonb`,
  [unitId]).then((r) => {
  if (!r.rows[0]) throw notFound('Online booking is not available for this.');
  return r.rows[0];
});
const setting = async (c, unitId, key, fallback) =>
  (await c.query('SELECT value FROM business_unit_setting WHERE business_unit_id = $1 AND key = $2', [unitId, key])).rows[0]?.value ?? fallback;

async function findOrCreateCustomer(c, guest) {
  const digits = guest.phone.replace(/\D/g, '').slice(-10);
  const found = (await c.query(
    `SELECT id FROM customer WHERE tenant_id = sec.current_tenant_id() AND (phone_normalized = $1 OR email = $2::citext)
      ORDER BY (phone_normalized = $1) DESC LIMIT 1`, [digits, guest.email])).rows[0];
  if (found) return found.id;
  return (await c.query(
    `INSERT INTO customer (tenant_id, full_name, phone, email) VALUES (sec.current_tenant_id(), $1, $2, $3) RETURNING id`,
    [guest.fullName, guest.phone, guest.email])).rows[0].id;
}

/** Creates the online booking record; returns the guest's secret link token. */
async function recordBooking(c, { unitId, reservationId, appointmentId, customerId, amount, holdMinutes }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = (await c.query(
    `INSERT INTO online_booking (tenant_id, business_unit_id, reservation_id, appointment_id, customer_id, manage_token_hash,
                                 amount_due, payment_status)
     VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [unitId, reservationId ?? null, appointmentId ?? null, customerId, hashToken(token), amount, amount > 0 ? 'pending' : 'not_needed'])).rows[0].id;
  if (amount > 0) await c.query('SELECT web.set_hold($1, $2)', [id, holdMinutes]);
  return { id, token };
}

/** Starts a payment with the gateway for a pending booking; returns the page to send the guest to. */
async function startPayment(req, t, bookingId, token, email) {
  const reference = `GDY-${crypto.randomBytes(9).toString('base64url')}`;
  const b = (await withContext(ctx(req, t), async (c) => {
    await c.query('UPDATE online_booking SET payment_reference = $2, gateway = $3, gateway_data = $4 WHERE id = $1',
      [bookingId, reference, gatewayName(), JSON.stringify({
        started_at: new Date().toISOString(),
        // Only the test gateway needs to know where to send the guest back (Paystack is told via callback_url).
        ...(gatewayName() === 'test' ? { return_url: `/book/manage/${token}` } : {}),
      })]);
    return (await c.query('SELECT amount_due FROM online_booking WHERE id = $1', [bookingId])).rows[0];
  }));
  const { url } = await gateway().initialize({
    email, amount: Number(b.amount_due), reference, callbackUrl: `${config.publicUrl}/book/manage/${token}`,
    metadata: { booking_id: bookingId },
  });
  return url;
}

/**
 * Applies a successful payment to the booking (idempotent): posts it to the guest bill or folio,
 * releases the hold and tells the unit's staff. A payment that arrives after the hold was released
 * is kept on record and flagged for a refund.
 */
async function confirmPayment(c, bookingId, result) {
  const o = (await c.query('SELECT * FROM online_booking WHERE id = $1 FOR UPDATE', [bookingId])).rows[0];
  if (!o || o.payment_status === 'paid' || o.payment_status === 'not_needed') return o;
  if (result.status !== 'success') {
    await c.query(`UPDATE online_booking SET gateway_data = gateway_data || $2 WHERE id = $1`,
      [o.id, JSON.stringify({ last_status: result.status, checked_at: new Date().toISOString() })]);
    return o;
  }
  if (Math.round(Number(result.amount) * 100) !== Math.round(Number(o.amount_due) * 100) || (result.currency && result.currency !== o.currency)) {
    await c.query(`UPDATE online_booking SET gateway_data = gateway_data || $2 WHERE id = $1`,
      [o.id, JSON.stringify({ mismatch: { amount: result.amount, currency: result.currency } })]);
    await c.query('SELECT web.notify($1, $2, $3, $4)', [o.business_unit_id, 'Online payment needs checking',
      `Reference ${o.payment_reference}: the amount paid does not match the deposit due.`, null]);
    return o;
  }
  const live = o.reservation_id
    ? (await c.query(`SELECT r.status = 'confirmed' AS live, r.booking_ref, f.id AS folio_id FROM reservation r JOIN folio f ON f.reservation_id = r.id WHERE r.id = $1`, [o.reservation_id])).rows[0]
    : (await c.query(`SELECT a.status = 'booked' AS live, a.booking_ref FROM appointment a WHERE a.id = $1`, [o.appointment_id])).rows[0];
  if (!live.live) {
    await c.query(`UPDATE online_booking SET payment_status = 'paid', paid_at = now(), gateway_data = gateway_data || '{"late": true}' WHERE id = $1`, [o.id]);
    await c.query('SELECT web.notify($1, $2, $3, $4)', [o.business_unit_id, 'Late online payment: refund due',
      `${live.booking_ref} was released before the payment (${o.payment_reference}) arrived. Refund it from the Paystack dashboard or rebook the guest.`, null]);
    return o;
  }
  if (o.reservation_id) {
    await c.query(`SELECT apt.folio_post($1, 'payment', 'Online payment (Paystack)', $2, 'card', $3)`, [live.folio_id, o.amount_due, o.payment_reference]);
  } else {
    await c.query(`SELECT bk.bill_post($1, 'payment', 'Online deposit (Paystack)', $2, 'card', $3)`, [o.appointment_id, o.amount_due, o.payment_reference]);
  }
  await c.query('SELECT web.set_hold($1, NULL)', [o.id]);
  await c.query(`UPDATE online_booking SET payment_status = 'paid', paid_at = now() WHERE id = $1`, [o.id]);
  await c.query('SELECT web.notify($1, $2, $3, $4)', [o.business_unit_id, 'New online booking',
    `${live.booking_ref}: deposit paid online.`, o.reservation_id ? `/front-desk/${o.business_unit_id}/reservations/${o.reservation_id}`
      : `/appointments/${o.business_unit_id}/${o.appointment_id}`]);
  return o;
}

const sweep = (c) => c.query('SELECT web.expire_holds()');

/** Releases unpaid holds for every tenant that has some (run on a timer). */
export async function sweepHolds() {
  const tenants = (await withContext({}, (c) => c.query('SELECT * FROM web.tenants_with_holds()'))).rows;
  for (const t of tenants) {
    await withContext({ userId: t.agent_id, tenantId: t.tenant_id }, sweep).catch((err) => console.error('hold sweep', err.message));
  }
}

export function publicRoutes() {
  const router = Router();
  const writes = rateLimit({ windowMs: 60_000, limit: config.isTest ? 100_000 : 20, standardHeaders: 'draft-8', legacyHeaders: false });

  // ---------------- payment gateway callbacks ----------------
  router.post('/paystack/webhook', async (req, res) => {
    let g;
    try { g = gateway(); } catch { return res.status(503).end(); }
    if (g.name !== 'paystack' || !g.verifySignature(req.rawBody, req.get('x-paystack-signature'))) return res.status(401).end();
    const event = req.body;
    if (event?.event === 'charge.success' && event.data?.reference) {
      const t = (await withContext({}, (c) => c.query('SELECT * FROM web.resolve_booking(NULL, $1)', [event.data.reference]))).rows[0];
      if (t?.tenant_id) {
        await withContext(ctx(req, t), (c) => confirmPayment(c, t.booking_id,
          { status: event.data.status, amount: event.data.amount / 100, currency: event.data.currency }));
      }
    }
    res.status(200).end();
  });

  // The test gateway's "payment page" (development only).
  router.get('/test-payments/:reference', async (req, res) => {
    const { reference } = parse(verifySchema, req.params);
    if (gatewayName() !== 'test') throw notFound();
    const t = (await withContext({}, (c) => c.query('SELECT * FROM web.resolve_booking(NULL, $1)', [reference]))).rows[0];
    if (!t?.tenant_id) throw notFound('Payment not found.');
    const row = await withContext(ctx(req, t), async (c) => (await c.query(
      `SELECT o.amount_due, o.currency, o.payment_status, bu.name AS unit_name, o.gateway_data ->> 'return_url' AS return_url,
              coalesce((SELECT booking_ref FROM reservation WHERE id = o.reservation_id), (SELECT booking_ref FROM appointment WHERE id = o.appointment_id)) AS booking_ref
         FROM online_booking o JOIN business_unit bu ON bu.id = o.business_unit_id WHERE o.id = $1`, [t.booking_id])).rows[0]);
    res.json(row);
  });
  router.post('/test-payments/:reference', writes, async (req, res) => {
    const { reference } = parse(verifySchema, req.params);
    const { outcome } = parse(outcomeSchema, req.body);
    if (gatewayName() !== 'test') throw notFound();
    const t = (await withContext({}, (c) => c.query('SELECT * FROM web.resolve_booking(NULL, $1)', [reference]))).rows[0];
    if (!t?.tenant_id) throw notFound('Payment not found.');
    await withContext(ctx(req, t), (c) => c.query(
      `UPDATE online_booking SET gateway_data = gateway_data || jsonb_build_object('test_outcome', $2::text) WHERE id = $1 AND payment_reference = $3`,
      [t.booking_id, outcome, reference]));
    res.status(204).end();
  });

  // ---------------- a guest's own booking (by secret link) ----------------
  const summary = async (c, bookingId) => {
    const o = (await c.query(
      `SELECT o.id, o.amount_due, o.currency, o.payment_status, o.paid_at, o.cancel_requested_at, o.payment_reference,
              bu.name AS unit_name, bu.unit_type, bu.time_zone, c.full_name AS guest_name,
              r.booking_ref AS res_ref, r.status AS res_status, r.check_in, r.check_out, r.hold_expires_at AS res_hold,
              (SELECT string_agg(t.name, ', ') FROM reservation_room rr JOIN room_type t ON t.id = rr.room_type_id WHERE rr.reservation_id = r.id) AS room_types,
              a.booking_ref AS appt_ref, a.status AS appt_status, a.starts_at, a.ends_at, a.hold_expires_at AS appt_hold, s.name AS service_name,
              (SELECT value FROM business_unit_setting WHERE business_unit_id = bu.id AND key = 'online.cancel_hours') AS cancel_hours,
              extract(epoch FROM coalesce(a.starts_at, (r.check_in + time '14:00') AT TIME ZONE bu.time_zone) - now()) / 3600 AS hours_left,
              to_char(r.check_in, 'YYYY-MM-DD') AS check_in_text, to_char(r.check_out, 'YYYY-MM-DD') AS check_out_text
         FROM online_booking o JOIN business_unit bu ON bu.id = o.business_unit_id JOIN customer c ON c.id = o.customer_id
         LEFT JOIN reservation r ON r.id = o.reservation_id
         LEFT JOIN appointment a ON a.id = o.appointment_id LEFT JOIN bookable_service s ON s.id = a.service_id
        WHERE o.id = $1`, [bookingId])).rows[0];
    const kind = o.res_ref ? 'stay' : 'appointment';
    const status = o.res_status ?? o.appt_status;
    const active = ['confirmed', 'booked'].includes(status);
    const hoursLeft = Number(o.hours_left);
    const paidSomething = o.payment_status === 'paid';
    return {
      kind, unitName: o.unit_name, unitType: o.unit_type, timeZone: o.time_zone, guestName: o.guest_name,
      bookingRef: o.res_ref ?? o.appt_ref, status, roomTypes: o.room_types, checkIn: o.check_in_text, checkOut: o.check_out_text,
      serviceName: o.service_name, startsAt: o.starts_at, endsAt: o.ends_at,
      amountDue: Number(o.amount_due), currency: o.currency, paymentStatus: o.payment_status, paidAt: o.paid_at,
      holdExpiresAt: o.res_hold ?? o.appt_hold, cancelRequestedAt: o.cancel_requested_at, cancelHours: Number(o.cancel_hours ?? 24),
      canPay: active && o.payment_status === 'pending',
      canCancel: active && !paidSomething && (o.payment_status === 'pending' || hoursLeft >= Number(o.cancel_hours ?? 24)),
      canRequestCancel: active && paidSomething && !o.cancel_requested_at,
    };
  };

  router.get('/manage/:token', async (req, res) => {
    const t = await resolveToken(req);
    res.json(await withContext(ctx(req, t), async (c) => { await sweep(c); return summary(c, t.booking_id); }));
  });

  router.post('/manage/:token/verify', writes, async (req, res) => {
    const t = await resolveToken(req);
    const { reference } = parse(verifySchema, req.body);
    const row = (await withContext(ctx(req, t), (c) => c.query('SELECT * FROM online_booking WHERE id = $1', [t.booking_id]))).rows[0];
    if (row.payment_reference !== reference) throw badRequest('That payment does not belong to this booking.');
    if (row.payment_status === 'pending') {
      const result = await gateway().verify(reference, row);
      await withContext(ctx(req, t), (c) => confirmPayment(c, t.booking_id, result));
    }
    res.json(await withContext(ctx(req, t), (c) => summary(c, t.booking_id)));
  });

  router.post('/manage/:token/pay', writes, async (req, res) => {
    const t = await resolveToken(req);
    const { token } = req.params;
    const info = await withContext(ctx(req, t), async (c) => {
      await sweep(c);
      const s = await summary(c, t.booking_id);
      const email = (await c.query('SELECT c.email FROM online_booking o JOIN customer c ON c.id = o.customer_id WHERE o.id = $1', [t.booking_id])).rows[0].email;
      return { s, email };
    });
    if (!info.s.canPay) throw badRequest('This booking has nothing to pay online.');
    res.json({ paymentUrl: await startPayment(req, t, t.booking_id, token, info.email) });
  });

  router.post('/manage/:token/cancel', writes, async (req, res) => {
    const t = await resolveToken(req);
    const result = await withContext(ctx(req, t), async (c) => {
      const s = await summary(c, t.booking_id);
      const o = (await c.query('SELECT * FROM online_booking WHERE id = $1 FOR UPDATE', [t.booking_id])).rows[0];
      if (s.canCancel) {
        if (o.reservation_id) await c.query(`SELECT apt.cancel($1, 'cancelled', 'Cancelled online by the guest')`, [o.reservation_id]);
        else await c.query(`SELECT bk.cancel($1, 'cancelled', 'Cancelled online by the guest', false)`, [o.appointment_id]);
        if (o.payment_status === 'pending') await c.query(`UPDATE online_booking SET payment_status = 'expired' WHERE id = $1`, [o.id]);
        await c.query('SELECT web.notify($1, $2, $3, $4)', [o.business_unit_id, 'Online booking cancelled by the guest', s.bookingRef, null]);
        return 'cancelled';
      }
      if (s.canRequestCancel) {
        await c.query('UPDATE online_booking SET cancel_requested_at = now() WHERE id = $1', [o.id]);
        await c.query('SELECT web.notify($1, $2, $3, $4)', [o.business_unit_id, 'Guest asks to cancel a paid online booking',
          `${s.bookingRef}: decide on the refund and cancel it.`, o.reservation_id ? `/front-desk/${o.business_unit_id}/reservations/${o.reservation_id}`
            : `/appointments/${o.business_unit_id}/${o.appointment_id}`]);
        return 'requested';
      }
      throw badRequest(s.status && !['confirmed', 'booked'].includes(s.status) ? 'This booking is no longer active.'
        : `Online cancellation closes ${s.cancelHours} hours before the start. Please call us.`);
    });
    res.json({ result, booking: await withContext(ctx(req, t), (c) => summary(c, t.booking_id)) });
  });

  // ---------------- a tenant's public booking page ----------------
  router.get('/:slug', async (req, res) => {
    const t = await resolveSlug(req);
    const units = await withContext(ctx(req, t), async (c) => (await c.query(
      `SELECT bu.id, bu.code, bu.name, bu.unit_type FROM business_unit bu
        WHERE bu.tenant_id = sec.current_tenant_id() AND bu.is_active
          AND (SELECT value FROM business_unit_setting WHERE business_unit_id = bu.id AND key = 'online.enabled') = 'true'::jsonb
        ORDER BY CASE bu.unit_type WHEN 'apartments' THEN 1 WHEN 'spa' THEN 2 ELSE 3 END`)).rows);
    res.json({ name: t.tenant_name, gateway: gatewayName(), units });
  });

  router.get('/:slug/rooms', async (req, res) => {
    const t = await resolveSlug(req);
    const q = parse(roomQuery, req.query);
    if (q.checkOut <= q.checkIn) throw badRequest('Check-out must be after check-in.');
    const rows = await withContext(ctx(req, t), async (c) => {
      const unit = await enabled(c, q.unitId);
      if (unit.unit_type !== 'apartments') throw notFound('Online booking is not available for this.');
      await sweep(c);
      const pct = Number(await setting(c, unit.id, 'online.deposit_pct', 100));
      return (await c.query(
        `SELECT t.id AS room_type_id, t.name, t.description, t.max_adults, t.max_children, t.amenities, x.nights, x.stay_net,
                bk.gross($1, x.stay_net) AS stay_total, round(bk.gross($1, x.stay_net) * $5 / 100, 2) AS deposit,
                (SELECT count(*) FROM room r WHERE r.room_type_id = t.id AND r.is_active AND r.status <> 'out_of_order'
                    AND NOT EXISTS (SELECT 1 FROM room_night n WHERE n.room_id = r.id AND n.stay_date >= $2 AND n.stay_date < $3))::int AS free
           FROM room_type t
           CROSS JOIN LATERAL (SELECT count(*)::int AS nights, sum(apt.nightly_rate(t.id, d::date)) AS stay_net
                                 FROM generate_series($2::date, $3::date - 1, interval '1 day') d) x
          WHERE t.business_unit_id = $1 AND t.is_active AND t.max_adults >= $4
          ORDER BY x.stay_net`, [unit.id, q.checkIn, q.checkOut, q.adults, pct])).rows;
    });
    res.json(rows.filter((r) => r.free > 0).map(({ free, ...r }) => ({ ...r, available: true })));
  });

  router.post('/:slug/rooms', writes, async (req, res) => {
    const t = await resolveSlug(req);
    const b = parse(roomBooking, req.body);
    const made = await withContext(ctx(req, t), async (c) => {
      const unit = await enabled(c, b.unitId);
      if (unit.unit_type !== 'apartments') throw notFound('Online booking is not available for this.');
      await sweep(c);
      const customerId = await findOrCreateCustomer(c, b.guest);
      const resId = (await c.query(`SELECT apt.book($1, $2, 'online', $3, $4, $5, $6, $7, $8) AS id`,
        [unit.id, customerId, b.checkIn, b.checkOut, b.adults, b.children, b.notes ?? null, JSON.stringify([{ roomTypeId: b.roomTypeId }])])).rows[0].id;
      const pct = Number(await setting(c, unit.id, 'online.deposit_pct', 100));
      const amount = Number((await c.query(
        `SELECT round(bk.gross($2, sum(n.rate)) * $3 / 100, 2) AS a FROM room_night n JOIN reservation_room rr ON rr.id = n.reservation_room_id
          WHERE rr.reservation_id = $1`, [resId, unit.id, pct])).rows[0].a);
      const hold = Number(await setting(c, unit.id, 'online.hold_minutes', 30));
      const rec = await recordBooking(c, { unitId: unit.id, reservationId: resId, customerId, amount, holdMinutes: hold });
      const ref = (await c.query('SELECT booking_ref FROM reservation WHERE id = $1', [resId])).rows[0].booking_ref;
      if (amount === 0) {
        await c.query('SELECT web.notify($1, $2, $3, $4)', [unit.id, 'New online booking', `${ref}: no deposit needed.`, `/front-desk/${unit.id}/reservations/${resId}`]);
      }
      return { ...rec, amount, bookingRef: ref };
    });
    const paymentUrl = made.amount > 0 ? await startPayment(req, t, made.id, made.token, b.guest.email) : null;
    res.status(201).json({ token: made.token, bookingRef: made.bookingRef, amount: made.amount, paymentUrl });
  });

  router.get('/:slug/units/:unitId/services', async (req, res) => {
    const t = await resolveSlug(req);
    const { unitId } = parse(unitParams, req.params);
    res.json(await withContext(ctx(req, t), async (c) => {
      const unit = await enabled(c, unitId);
      const services = (await c.query(
        `SELECT s.id, s.name, s.description, s.mode, s.duration_min, s.min_slots, s.max_slots, s.price, s.deposit_pct
           FROM bookable_service s WHERE s.business_unit_id = $1 AND s.is_active AND s.online_bookable
            AND EXISTS (SELECT 1 FROM service_resource sr WHERE sr.service_id = s.id) ORDER BY s.name`, [unit.id])).rows;
      return { unit: { id: unit.id, name: unit.name, unitType: unit.unit_type, timeZone: unit.time_zone }, services };
    }));
  });

  router.get('/:slug/units/:unitId/availability', async (req, res) => {
    const t = await resolveSlug(req);
    const { unitId } = parse(unitParams, req.params);
    const q = parse(slotQuery, req.query);
    res.json(await withContext(ctx(req, t), async (c) => {
      await enabled(c, unitId);
      const ok = (await c.query('SELECT 1 FROM bookable_service WHERE id = $1 AND business_unit_id = $2 AND online_bookable AND is_active', [q.serviceId, unitId])).rows[0];
      if (!ok) throw notFound('That service cannot be booked online.');
      await sweep(c);
      return (await c.query(`SELECT starts_at, ends_at FROM bk.availability($1, $2, $3, '{}')`, [q.serviceId, q.date, q.slots ?? null])).rows;
    }));
  });

  router.post('/:slug/units/:unitId/appointments', writes, async (req, res) => {
    const t = await resolveSlug(req);
    const { unitId } = parse(unitParams, req.params);
    const b = parse(appointmentBooking, req.body);
    const made = await withContext(ctx(req, t), async (c) => {
      const unit = await enabled(c, unitId);
      const ok = (await c.query('SELECT 1 FROM bookable_service WHERE id = $1 AND business_unit_id = $2 AND online_bookable AND is_active', [b.serviceId, unit.id])).rows[0];
      if (!ok) throw notFound('That service cannot be booked online.');
      await sweep(c);
      const customerId = await findOrCreateCustomer(c, b.guest);
      const apptId = (await c.query(`SELECT bk.book($1, $2, $3, $4, 'online', $5, '{}') AS id`,
        [b.serviceId, customerId, b.startsAt, b.slots ?? null, b.notes ?? null])).rows[0].id;
      const a = (await c.query('SELECT booking_ref, deposit_due FROM appointment WHERE id = $1', [apptId])).rows[0];
      const amount = Number(a.deposit_due);
      const hold = Number(await setting(c, unit.id, 'online.hold_minutes', 30));
      const rec = await recordBooking(c, { unitId: unit.id, appointmentId: apptId, customerId, amount, holdMinutes: hold });
      if (amount === 0) {
        await c.query('SELECT web.notify($1, $2, $3, $4)', [unit.id, 'New online booking', `${a.booking_ref}: no deposit needed.`, `/appointments/${unit.id}/${apptId}`]);
      }
      return { ...rec, amount, bookingRef: a.booking_ref };
    });
    const paymentUrl = made.amount > 0 ? await startPayment(req, t, made.id, made.token, b.guest.email) : null;
    res.status(201).json({ token: made.token, bookingRef: made.bookingRef, amount: made.amount, paymentUrl });
  });

  return router;
}
