// Public booking pages: guests book rooms, Spa treatments and Studio hire without an account,
// pay deposits through the gateway (the built-in test gateway here; Paystack via its signed webhook),
// and manage their booking through a secret link.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDatabase, signIn, closePools, ownerQuery, request, app, roleIdByCode } from './helpers.js';
import { config } from '../src/config.js';

let seed, owner, partner, it, slug;
let std, massage, booth, spaGuestToken;
const pub = {
  get: (url) => request(app).get(`/api/public${url}`),
  post: (url, body) => request(app).post(`/api/public${url}`).set('x-requested-with', 'giddy').send(body ?? {}),
};
const day = (o) => { const d = new Date(Date.now() + 3600_000); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
const allDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: '00:00', closes: '24:00' }));
const guest = (n) => ({ fullName: `Guest ${n}`, phone: `0809000000${n}`, email: `guest${n}@example.com` });
const enable = (api, unit, on = true) => api.put(`/api/org/business-units/${seed.units[unit]}/settings/online.enabled`, { value: on });
const refOf = (url) => decodeURIComponent(url.split('/').pop());
const pay = async (token, url, outcome = 'success') => {
  const reference = refOf(url);
  assert.equal((await pub.post(`/test-payments/${reference}`, { outcome })).status, 204);
  return pub.post(`/manage/${token}/verify`, { reference });
};

before(async () => {
  seed = await resetDatabase();
  [owner, partner, it] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local'), signIn('it@test.local')]);
  slug = (await ownerQuery('SELECT public_slug FROM tenant WHERE id = $1', [seed.tenantId])).rows[0].public_slug;

  const A = `/api/apartments/${seed.units.APARTMENTS}`;
  std = (await owner.post(`${A}/room-types`, { code: 'STD', name: 'Standard apartment', baseRate: 50000 })).body;
  for (const n of ['101', '102']) await owner.post(`${A}/rooms`, { roomNumber: n, roomTypeId: std.id, branchId: seed.branchId });

  const S = `/api/bookings/${seed.units.SPA}`;
  const t = (await partner.post(`${S}/resources`, { kind: 'staff', name: 'Ada', hours: allDay })).body;
  const r = (await partner.post(`${S}/resources`, { kind: 'room', name: 'Room 1', hours: allDay })).body;
  massage = (await partner.post(`${S}/services`, { code: 'SWE', name: 'Swedish massage', mode: 'service', durationMin: 60, price: 30000,
    depositPct: 50, onlineBookable: true, resources: [{ resourceId: t.id, role: 'therapist' }, { resourceId: r.id, role: 'room' }] })).body;
  await partner.post(`${S}/services`, { code: 'PRIV', name: 'Private consultation', mode: 'service', durationMin: 30, price: 10000,
    resources: [{ resourceId: t.id, role: 'therapist' }, { resourceId: r.id, role: 'room' }] });

  const T = `/api/bookings/${seed.units.STUDIO}`;
  const b = (await owner.post(`${T}/resources`, { kind: 'booth', name: 'Booth A', hours: allDay })).body;
  booth = (await owner.post(`${T}/services`, { code: 'BOOTH', name: 'Booth hire', mode: 'slot', durationMin: 60, maxSlots: 4, price: 20000,
    onlineBookable: true, resources: [{ resourceId: b.id, role: 'booth' }] })).body;
});
after(closePools);

test('the system account is invisible, cannot sign in, and its role is not assignable', async () => {
  assert.ok(!(await it.get('/api/users')).body.some((u) => u.full_name === 'Online booking'));
  assert.ok(!(await owner.get('/api/roles')).body.some((r) => r.code === 'ONLINE_BOOKING'));
  const email = (await ownerQuery('SELECT email FROM app_user WHERE is_system')).rows[0].email;
  assert.equal((await request(app).post('/api/auth/login').set('x-requested-with', 'giddy').send({ email, password: 'disabled' })).status, 401);
  const role = (await ownerQuery(`SELECT id FROM role WHERE code = 'ONLINE_BOOKING'`)).rows[0].id;
  const grant = await owner.post('/api/assignments', { userId: seed.users.it, roleId: role, businessUnitId: seed.units.FNB });
  assert.ok([400, 403].includes(grant.status), String(grant.status));
  assert.ok(await roleIdByCode(owner, 'CASHIER'));
});

test('units appear online only when their own managers turn it on', async () => {
  assert.equal((await pub.get('/no-such-place')).status, 404);
  assert.deepEqual((await pub.get(`/${slug}`)).body.units, []);
  assert.equal((await enable(owner, 'APARTMENTS')).status, 200);
  assert.equal((await enable(owner, 'SPA')).status, 403, 'the Owner only reads the Spa');
  assert.equal((await enable(partner, 'SPA')).status, 200);
  assert.equal((await enable(owner, 'STUDIO')).status, 200);
  const page = (await pub.get(`/${slug}`)).body;
  assert.equal(page.name, 'Giddy Test');
  assert.equal(page.gateway, 'test');
  assert.deepEqual(page.units.map((u) => u.code), ['APARTMENTS', 'SPA', 'STUDIO']);
  assert.equal((await pub.get(`/${slug}/rooms?unitId=${seed.units.FNB}&checkIn=${day(5)}&checkOut=${day(7)}`)).status, 404);
});

let stayToken, stayUrl;
test('a guest books a stay; the deposit (the whole stay by default) is held until paid', async () => {
  const rooms = (await pub.get(`/${slug}/rooms?unitId=${seed.units.APARTMENTS}&checkIn=${day(5)}&checkOut=${day(7)}&adults=2`)).body;
  assert.equal(rooms.length, 1);
  assert.equal(Number(rooms[0].stay_net), 100000);
  assert.equal(Number(rooms[0].stay_total), 118250, 'with 10% service charge and 7.5% VAT');
  assert.equal(Number(rooms[0].deposit), 118250);
  assert.ok(!JSON.stringify(rooms).includes('101'), 'room numbers are not published');

  const r = await pub.post(`/${slug}/rooms`, { unitId: seed.units.APARTMENTS, roomTypeId: std.id, checkIn: day(5), checkOut: day(7), adults: 2, guest: guest(1) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.bookingRef, /^RES-APARTMENTS-/);
  assert.match(r.body.paymentUrl, /\/book\/pay\/GDY-/);
  stayToken = r.body.token;
  stayUrl = r.body.paymentUrl;

  const m = (await pub.get(`/manage/${stayToken}`)).body;
  assert.deepEqual([m.status, m.paymentStatus, m.canPay, m.amountDue], ['confirmed', 'pending', true, 118250]);
  assert.ok(new Date(m.holdExpiresAt) > new Date());
  const staffView = (await owner.get(`/api/apartments/${seed.units.APARTMENTS}/reservations?q=Guest 1`)).body[0];
  assert.equal(staffView.source, 'online');
});

test('paying through the gateway posts the deposit to the guest bill and tells the front desk', async () => {
  const declined = await pay(stayToken, stayUrl, 'failed');
  assert.equal(declined.body.paymentStatus, 'pending', 'a declined card leaves the hold in place');
  const ok = await pay(stayToken, stayUrl);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.paymentStatus, 'paid');
  assert.equal(ok.body.holdExpiresAt, null);
  const res = (await owner.get(`/api/apartments/${seed.units.APARTMENTS}/reservations?q=Guest 1`)).body[0];
  const detail = (await owner.get(`/api/apartments/${seed.units.APARTMENTS}/reservations/${res.id}`)).body;
  const payment = detail.folio.entries.find((e) => e.entry_type === 'payment');
  assert.equal(Number(payment.amount), -118250);
  assert.equal(payment.reference, refOf(stayUrl));
  assert.equal(detail.created_by_name, 'Online booking');
  assert.ok((await owner.get('/api/notifications')).body.items.some((n) => n.kind === 'online_booking' && n.title === 'New online booking'));
  const again = await pub.post(`/manage/${stayToken}/verify`, { reference: refOf(stayUrl) });
  assert.equal(again.body.paymentStatus, 'paid', 'verifying twice changes nothing');
  assert.equal(detail.folio.entries.filter((e) => e.entry_type === 'payment').length, 1);
});

test('online bookings obey the same no-double-booking rules', async () => {
  const body = { unitId: seed.units.APARTMENTS, roomTypeId: std.id, checkIn: day(5), checkOut: day(6), guest: guest(2) };
  assert.equal((await pub.post(`/${slug}/rooms`, body)).status, 201);
  const full = await pub.post(`/${slug}/rooms`, { ...body, guest: guest(3) });
  assert.equal(full.status, 400);
  assert.match(full.body.error, /no .* room is free/i);
  assert.equal((await pub.get(`/${slug}/rooms?unitId=${seed.units.APARTMENTS}&checkIn=${day(5)}&checkOut=${day(6)}`)).body.length, 0);
});

test('an unpaid hold is released when it expires, and the room is free again', async () => {
  const r = (await pub.post(`/${slug}/rooms`, { unitId: seed.units.APARTMENTS, roomTypeId: std.id, checkIn: day(10), checkOut: day(11), guest: guest(4) })).body;
  await ownerQuery(`UPDATE reservation SET hold_expires_at = now() - interval '1 minute' WHERE booking_ref = $1`, [r.bookingRef]);
  const m = (await pub.get(`/manage/${r.token}`)).body;
  assert.deepEqual([m.status, m.paymentStatus, m.canPay], ['cancelled', 'expired', false]);
  assert.equal((await pub.get(`/${slug}/rooms?unitId=${seed.units.APARTMENTS}&checkIn=${day(10)}&checkOut=${day(11)}`)).body.length, 1);
  assert.equal((await pub.post(`/manage/${r.token}/pay`)).status, 400);
});

test('Spa: only online services; times without names; a 50% deposit on the treatment', async () => {
  const s = (await pub.get(`/${slug}/units/${seed.units.SPA}/services`)).body;
  assert.deepEqual(s.services.map((x) => x.name), ['Swedish massage']);
  const times = (await pub.get(`/${slug}/units/${seed.units.SPA}/availability?serviceId=${massage.id}&date=${day(3)}`)).body;
  assert.ok(times.length > 10);
  assert.deepEqual(Object.keys(times[0]).sort(), ['ends_at', 'starts_at'], 'who and which room stay private');
  const b = await pub.post(`/${slug}/units/${seed.units.SPA}/appointments`, { serviceId: massage.id, startsAt: times[4].starts_at, guest: guest(5) });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.amount, 15000);
  spaGuestToken = b.body.token;
  assert.equal((await pay(b.body.token, b.body.paymentUrl)).body.paymentStatus, 'paid');
  const appt = (await partner.get(`/api/bookings/${seed.units.SPA}/appointments?q=Guest 5`)).body[0];
  assert.equal(appt.source, 'online');
  assert.equal(Number(appt.paid), 15000);
  const taken = await pub.post(`/${slug}/units/${seed.units.SPA}/appointments`, { serviceId: massage.id, startsAt: times[4].starts_at, guest: guest(6) });
  assert.equal(taken.status, 409);
  assert.equal((await pub.post(`/${slug}/units/${seed.units.SPA}/appointments`,
    { serviceId: (await partner.get(`/api/bookings/${seed.units.SPA}/setup`)).body.services.find((x) => x.code === 'PRIV').id, startsAt: times[8].starts_at, guest: guest(6) })).status, 404);
});

test('Studio: no deposit needed, so the booking is confirmed at once', async () => {
  const times = (await pub.get(`/${slug}/units/${seed.units.STUDIO}/availability?serviceId=${booth.id}&date=${day(2)}&slots=2`)).body;
  const b = await pub.post(`/${slug}/units/${seed.units.STUDIO}/appointments`, { serviceId: booth.id, startsAt: times[10].starts_at, slots: 2, guest: guest(7) });
  assert.equal(b.status, 201);
  assert.deepEqual([b.body.amount, b.body.paymentUrl], [0, null]);
  const m = (await pub.get(`/manage/${b.body.token}`)).body;
  assert.deepEqual([m.paymentStatus, m.holdExpiresAt, m.serviceName], ['not_needed', null, 'Booth hire']);
  assert.equal((await pub.post(`/manage/${b.body.token}/cancel`)).body.result, 'cancelled');
});

test('cancelling online: unpaid bookings cancel; paid ones become a request to the staff', async () => {
  const r = (await pub.post(`/${slug}/rooms`, { unitId: seed.units.APARTMENTS, roomTypeId: std.id, checkIn: day(20), checkOut: day(21), guest: guest(8) })).body;
  const c1 = await pub.post(`/manage/${r.token}/cancel`);
  assert.equal(c1.body.result, 'cancelled');
  assert.equal(c1.body.booking.status, 'cancelled');

  const c2 = await pub.post(`/manage/${spaGuestToken}/cancel`);
  assert.equal(c2.body.result, 'requested');
  assert.equal(c2.body.booking.status, 'booked', 'staff decide on the refund');
  assert.ok((await partner.get('/api/notifications')).body.items.some((n) => n.title === 'Guest asks to cancel a paid online booking'));
  assert.equal((await pub.post(`/manage/${spaGuestToken}/cancel`)).status, 400, 'asked once');

  await ownerQuery(`UPDATE business_unit_setting SET value = '72' WHERE business_unit_id = $1 AND key = 'online.cancel_hours'`, [seed.units.STUDIO]);
  const times = (await pub.get(`/${slug}/units/${seed.units.STUDIO}/availability?serviceId=${booth.id}&date=${day(1)}`)).body;
  const late = (await pub.post(`/${slug}/units/${seed.units.STUDIO}/appointments`, { serviceId: booth.id, startsAt: times[0].starts_at, guest: guest(9) })).body;
  const c3 = await pub.post(`/manage/${late.token}/cancel`);
  assert.equal(c3.status, 400);
  assert.match(c3.body.error, /closes 72 hours before/);
  assert.equal((await pub.get('/manage/not-a-real-token-but-long-enough-0000000000000')).status, 404);
});

test('Paystack webhook: only correctly signed events count, and the amount must match', async () => {
  const r = (await pub.post(`/${slug}/rooms`, { unitId: seed.units.APARTMENTS, roomTypeId: std.id, checkIn: day(30), checkOut: day(31), guest: guest(10) })).body;
  const reference = refOf(r.paymentUrl);
  const send = (event, key) => {
    const raw = JSON.stringify(event);
    const sig = crypto.createHmac('sha512', key).update(raw).digest('hex');
    return request(app).post('/api/public/paystack/webhook').set('content-type', 'application/json').set('x-paystack-signature', sig).send(raw);
  };
  const event = (amount) => ({ event: 'charge.success', data: { reference, status: 'success', amount: amount * 100, currency: 'NGN' } });
  config.paystackSecretKey = 'sk_test_webhook';
  try {
    assert.equal((await send(event(r.amount), 'wrong-key')).status, 401);
    assert.equal((await send(event(r.amount - 1), 'sk_test_webhook')).status, 200);
    assert.equal((await pub.get(`/manage/${r.token}`)).body.paymentStatus, 'pending', 'short payment is not accepted');
    assert.ok((await owner.get('/api/notifications')).body.items.some((n) => n.title === 'Online payment needs checking'));
    assert.equal((await send(event(r.amount), 'sk_test_webhook')).status, 200);
    assert.equal((await pub.get(`/manage/${r.token}`)).body.paymentStatus, 'paid');
  } finally {
    config.paystackSecretKey = '';
  }
});

test('every change is in the audit chain', async () => {
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
