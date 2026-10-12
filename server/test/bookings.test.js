import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, staffMember, ownerQuery } from './helpers.js';

let seed, owner, partner, therapist, studioDesk;
let ada, bisi, room1, room2, swedish, facial, boothA, boothB, boothHire, guest, guest2;
const SPA = () => `/api/bookings/${seed.units.SPA}`;
const STUDIO = () => `/api/bookings/${seed.units.STUDIO}`;
// A local (Africa/Lagos, UTC+1) date n days from now, and a local time on it.
const day = (o) => { const d = new Date(Date.now() + 3600_000); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
const at = (date, hhmm) => `${date}T${hhmm}:00+01:00`;
const iso = (s) => new Date(s).toISOString();
const D = day(3);
const allWeek = (opens, closes) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens, closes }));

before(async () => {
  seed = await resetDatabase();
  [owner, partner] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local')]);
  therapist = await staffMember(owner, { email: 'ada@test.local', role: 'STAFF', businessUnitId: seed.units.SPA });
  studioDesk = await staffMember(owner, { email: 'studio@test.local', role: 'FRONT_DESK', businessUnitId: seed.units.STUDIO });
  guest = (await partner.post('/api/customers', { fullName: 'Funmi Ade', phone: '08031110000' })).body;
  guest2 = (await partner.post('/api/customers', { fullName: 'Gozie Obi', phone: '08031110001' })).body;
});
after(closePools);

const book = (api, base, body) => api.post(`${base}/appointments`, { source: 'direct', ...body });
const getAppt = async (base, id, api = partner) => (await api.get(`${base}/appointments/${id}`)).body;
const avail = async (api, base, serviceId, date, extra = '') =>
  (await api.get(`${base}/availability?serviceId=${serviceId}&date=${date}${extra}`)).body;

test('the spa partner sets up therapists, rooms, hours and services', async () => {
  const people = (await partner.get(`${SPA()}/people`)).body;
  assert.ok(people.some((p) => p.id === therapist.userId));
  const res = async (kind, name, userId) => {
    const r = await partner.post(`${SPA()}/resources`, { kind, name, userId, hours: allWeek('09:00', '18:00') });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  ada = await res('staff', 'Ada', therapist.userId);
  bisi = await res('staff', 'Bisi');
  room1 = await res('room', 'Room 1');
  const sw = await partner.post(`${SPA()}/services`, {
    code: 'SWE', name: 'Swedish massage', mode: 'service', durationMin: 60, bufferMin: 15, price: 30000,
    resources: [{ resourceId: ada.id, role: 'therapist' }, { resourceId: bisi.id, role: 'therapist' }, { resourceId: room1.id, role: 'room' }],
  });
  assert.equal(sw.status, 201, JSON.stringify(sw.body));
  swedish = sw.body;
  facial = (await partner.post(`${SPA()}/services`, {
    code: 'FAC', name: 'Facial', mode: 'service', durationMin: 30, price: 15000,
    resources: [{ resourceId: ada.id, role: 'therapist' }, { resourceId: room1.id, role: 'room' }],
  })).body;
  const setup = (await partner.get(`${SPA()}/setup`)).body;
  assert.equal(setup.timeZone, 'Africa/Lagos');
  assert.equal(setup.resources.find((r) => r.name === 'Ada').user_name, 'ada');
  assert.equal(setup.resources.find((r) => r.name === 'Ada').hours.length, 7);
  assert.equal(setup.services.find((s) => s.code === 'SWE').resources.length, 3);
});

test('overlapping opening hours are refused', async () => {
  const r = await partner.put(`${SPA()}/resources/${bisi.id}/hours`, {
    hours: [{ weekday: 1, opens: '09:00', closes: '13:00' }, { weekday: 1, opens: '12:00', closes: '18:00' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /overlap/i);
});

test('the owner sees the spa but cannot configure it or book in it', async () => {
  assert.equal((await owner.get(`${SPA()}/setup`)).body.services.length, 2);
  assert.equal((await owner.post(`${SPA()}/services`, { code: 'X1', name: 'Nope', mode: 'service', durationMin: 30, price: 1 })).status, 403);
  assert.equal((await book(owner, SPA(), { serviceId: swedish.id, customerId: guest.id, startsAt: at(D, '10:00') })).status, 403);
});

test('availability lists every start that has a therapist and a room', async () => {
  const slots = await avail(partner, SPA(), swedish.id, D);
  assert.equal(slots.length, 33, '09:00 to 17:00 every 15 minutes');
  assert.equal(iso(slots[0].starts_at), iso(at(D, '09:00')));
  assert.equal(iso(slots.at(-1).ends_at), iso(at(D, '18:00')));
  assert.deepEqual(slots[0].options.therapist.map((t) => t.name), ['Ada', 'Bisi']);
  assert.deepEqual(slots[0].options.room.map((t) => t.name), ['Room 1']);
});

let apptA, apptB;
test('service bookings hold the therapist and the room, including the clean-up buffer', async () => {
  const a = await book(partner, SPA(), { serviceId: swedish.id, customerId: guest.id, startsAt: at(D, '10:00'), notes: 'Firm pressure' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  apptA = a.body.id;
  const detail = await getAppt(SPA(), apptA);
  assert.match(detail.booking_ref, /^BKG-SPA-\d{6}$/i);
  assert.equal(Number(detail.price), 30000);
  assert.equal(iso(detail.ends_at), iso(at(D, '11:00')));
  assert.deepEqual(detail.resources.map((r) => r.role).sort(), ['room', 'therapist']);

  // Room 1 is held until 11:15 (60 min + 15 min buffer).
  const clash = await book(partner, SPA(), { serviceId: swedish.id, customerId: guest2.id, startsAt: at(D, '11:00') });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /no room is free for Swedish massage/i);
  const b = await book(partner, SPA(), { serviceId: swedish.id, customerId: guest2.id, startsAt: at(D, '11:15') });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  apptB = b.body.id;
  // Work is spread: the second booking goes to the other therapist.
  const ta = (await getAppt(SPA(), apptA)).resources.find((r) => r.role === 'therapist').name;
  const tb = (await getAppt(SPA(), apptB)).resources.find((r) => r.role === 'therapist').name;
  assert.notEqual(ta, tb);
});

test('times must be on 5-minute marks, in the future and within the booking window', async () => {
  const base = { serviceId: swedish.id, customerId: guest.id };
  assert.match((await book(partner, SPA(), { ...base, startsAt: at(D, '13:07') })).body.error, /5-minute/i);
  assert.match((await book(partner, SPA(), { ...base, startsAt: at(day(-1), '13:00') })).body.error, /passed/i);
  assert.match((await book(partner, SPA(), { ...base, startsAt: at(day(200), '13:00') })).body.error, /90 days/i);
  const late = await book(partner, SPA(), { ...base, startsAt: at(D, '17:30') });
  assert.equal(late.status, 409, 'would run past closing');
});

test('concurrent bookings for the same time never share a therapist or a room', async () => {
  room2 = (await partner.post(`${SPA()}/resources`, { kind: 'room', name: 'Room 2', hours: allWeek('09:00', '18:00') })).body;
  await partner.patch(`${SPA()}/services/${swedish.id}`, {
    resources: [{ resourceId: ada.id, role: 'therapist' }, { resourceId: bisi.id, role: 'therapist' },
      { resourceId: room1.id, role: 'room' }, { resourceId: room2.id, role: 'room' }],
  });
  const attempts = await Promise.all([0, 1, 2, 3, 4].map(() =>
    book(partner, SPA(), { serviceId: swedish.id, customerId: guest.id, startsAt: at(D, '14:00') })));
  assert.equal(attempts.filter((r) => r.status === 201).length, 2, 'two therapists, two rooms');
  assert.ok(attempts.filter((r) => r.status !== 201).every((r) => r.status === 409), JSON.stringify(attempts.map((r) => r.body)));
  const day14 = (await partner.get(`${SPA()}/day?date=${D}`)).body.appointments
    .filter((x) => iso(x.starts_at) === iso(at(D, '14:00')));
  const used = day14.flatMap((x) => x.resources.map((r) => r.resourceId));
  assert.equal(new Set(used).size, 4);
});

test('asking for a particular therapist', async () => {
  const notOffered = await book(partner, SPA(), {
    serviceId: facial.id, customerId: guest.id, startsAt: at(D, '16:00'), preferred: { therapist: bisi.id },
  });
  assert.equal(notOffered.status, 409, 'Bisi does not do facials');
  assert.match(notOffered.body.error, /the chosen therapist is not free/i);
  const ok = await book(partner, SPA(), {
    serviceId: facial.id, customerId: guest.id, startsAt: at(D, '16:00'), preferred: { therapist: ada.id },
  });
  assert.equal(ok.status, 201);
  const onlyAda = await avail(partner, SPA(), swedish.id, D, `&preferred=${encodeURIComponent(JSON.stringify({ therapist: ada.id }))}`);
  assert.ok(onlyAda.every((s) => s.options.therapist.length === 1 && s.options.therapist[0].name === 'Ada'));
  assert.ok(!onlyAda.some((s) => iso(s.starts_at) === iso(at(D, '16:00'))), 'Ada has a facial at 16:00');
});

test('slot rentals: booths are hired by the hour, for one to four hours', async () => {
  const res = async (name) => (await owner.post(`${STUDIO()}/resources`, { kind: 'booth', name, hours: allWeek('08:00', '22:00') })).body;
  boothA = await res('Booth A');
  boothB = await res('Booth B');
  boothHire = (await owner.post(`${STUDIO()}/services`, {
    code: 'BOOTH', name: 'Booth hire', mode: 'slot', durationMin: 60, minSlots: 1, maxSlots: 4, price: 20000,
    resources: [{ resourceId: boothA.id, role: 'booth' }, { resourceId: boothB.id, role: 'booth' }],
  })).body;
  const customer = (await studioDesk.api.post('/api/customers', { fullName: 'Kola Podcast', phone: '08032220000' })).body;
  const r = await book(studioDesk.api, STUDIO(), {
    serviceId: boothHire.id, customerId: customer.id, startsAt: at(D, '10:00'), slots: 2, preferred: { booth: boothA.id },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = await getAppt(STUDIO(), r.body.id, studioDesk.api);
  assert.equal(Number(a.price), 40000);
  assert.equal(iso(a.ends_at), iso(at(D, '12:00')));
  assert.equal(a.resources[0].name, 'Booth A');

  const two = await avail(studioDesk.api, STUDIO(), boothHire.id, D, '&slots=2');
  const startsAt = (t) => two.find((s) => iso(s.starts_at) === iso(at(D, t)));
  assert.equal(two.length, 13, 'hourly starts from 08:00 to 20:00');
  assert.deepEqual(startsAt('09:00').options.booth.map((b) => b.name), ['Booth B'], '09:00–11:00 overlaps Booth A');
  assert.deepEqual(startsAt('12:00').options.booth.map((b) => b.name), ['Booth A', 'Booth B']);
  const tooLong = await book(studioDesk.api, STUDIO(), { serviceId: boothHire.id, customerId: customer.id, startsAt: at(D, '13:00'), slots: 5 });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /1 to 4 slots/i);
  // The spa partner has no access to the studio.
  assert.equal((await partner.get(`${STUDIO()}/appointments/${r.body.id}`)).status, 404);
});

test('a therapist sees only their own bookings and cannot book', async () => {
  const mine = (await therapist.api.get(`${SPA()}/appointments?from=${D}&to=${D}`)).body;
  const all = (await partner.get(`${SPA()}/appointments?from=${D}&to=${D}`)).body;
  assert.ok(mine.length > 0 && mine.length < all.length);
  assert.ok(mine.every((a) => a.resources.some((r) => r.name === 'Ada')));
  const dayView = (await therapist.api.get(`${SPA()}/day?date=${D}`)).body;
  assert.ok(dayView.appointments.every((a) => a.resources.some((r) => r.name === 'Ada')));
  assert.equal(dayView.resources.find((r) => r.name === 'Ada').is_me, true);
  assert.equal((await book(therapist.api, SPA(), { serviceId: swedish.id, customerId: guest.id, startsAt: at(D, '09:00') })).status, 403);
  const inbox = (await therapist.api.get('/api/notifications')).body.items;
  assert.ok(inbox.some((n) => n.kind === 'appointment' && n.title === 'New booking'));
});

test('rescheduling moves the holds; a clash leaves the booking untouched', async () => {
  const before = await getAppt(SPA(), apptA);
  const clash = await partner.post(`${SPA()}/appointments/${apptA}/reschedule`, { startsAt: at(D, '14:00') });
  assert.equal(clash.status, 409);
  assert.equal(iso((await getAppt(SPA(), apptA)).starts_at), iso(before.starts_at));

  // Its own current time counts as free when looking for somewhere to move it.
  const same = Object.fromEntries(before.resources.map((r) => [r.role, r.resourceId]));
  const q = `&preferred=${encodeURIComponent(JSON.stringify(same))}`;
  const has0930 = (list) => list.some((s) => iso(s.starts_at) === iso(at(D, '09:30')));
  assert.equal(has0930(await avail(partner, SPA(), swedish.id, D, q)), false);
  assert.equal(has0930(await avail(partner, SPA(), swedish.id, D, `${q}&except=${apptA}`)), true);

  const moved = await partner.post(`${SPA()}/appointments/${apptA}/reschedule`, { startsAt: at(D, '15:30') });
  assert.equal(moved.status, 204, JSON.stringify(moved.body));
  const after = await getAppt(SPA(), apptA);
  assert.equal(iso(after.starts_at), iso(at(D, '15:30')));
  assert.equal(Number(after.price), 30000);
  const ten = (await avail(partner, SPA(), swedish.id, D)).find((s) => iso(s.starts_at) === iso(at(D, '10:00')));
  assert.ok(ten, '10:00 is free again');
});

test('blocking time: not over existing bookings; blocked time is not offered', async () => {
  const bisiBooking = (await partner.get(`${SPA()}/appointments?from=${D}&to=${D}`)).body
    .find((a) => a.resources.some((r) => r.name === 'Bisi'));
  const over = await partner.post(`${SPA()}/resources/${bisi.id}/blocks`, {
    from: bisiBooking.starts_at, to: bisiBooking.ends_at, reason: 'Training',
  });
  assert.equal(over.status, 409);
  assert.match(over.body.error, new RegExp(bisiBooking.booking_ref));

  const blk = await partner.post(`${SPA()}/resources/${bisi.id}/blocks`, { from: at(D, '09:00'), to: at(D, '10:00'), reason: 'Training' });
  assert.equal(blk.status, 201, JSON.stringify(blk.body));
  const nine = (await avail(partner, SPA(), swedish.id, D)).find((s) => iso(s.starts_at) === iso(at(D, '09:00')));
  assert.deepEqual(nine.options.therapist.map((t) => t.name), ['Ada']);
  assert.equal((await partner.get(`${SPA()}/day?date=${D}`)).body.resources.find((r) => r.name === 'Bisi').blocks.length, 1);
  assert.equal((await therapist.api.post(`${SPA()}/resources/${ada.id}/blocks`, { from: at(D, '17:00'), to: at(D, '18:00'), reason: 'Leave' })).status, 403);
  assert.equal((await partner.delete(`${SPA()}/blocks/${blk.body.id}`)).status, 204);
});

// Moves an appointment (and its holds) so that it started p minutes ago.
const startedAgo = (id, mins) => ownerQuery(
  `WITH a AS (UPDATE appointment SET starts_at = now() - make_interval(mins => $2),
                ends_at = now() - make_interval(mins => $2) + (ends_at - starts_at) WHERE id = $1 RETURNING starts_at, ends_at)
   UPDATE appointment_resource SET during = tstzrange((SELECT starts_at FROM a), (SELECT ends_at FROM a) + interval '15 minutes')
    WHERE appointment_id = $1`, [id, mins]);

test('check-in only on the day; completing early frees the rest of the time', async () => {
  const early = await partner.post(`${SPA()}/appointments/${apptB}/check-in`);
  assert.equal(early.status, 400);
  assert.match(early.body.error, /day of the appointment/i);
  assert.match((await partner.post(`${SPA()}/appointments/${apptB}/complete`)).body.error, /check the guest in first/i);

  await startedAgo(apptB, 10);
  assert.equal((await partner.post(`${SPA()}/appointments/${apptB}/check-in`)).status, 204);
  assert.equal((await partner.post(`${SPA()}/appointments/${apptB}/check-in`)).status, 400, 'already checked in');
  assert.equal((await partner.post(`${SPA()}/appointments/${apptB}/reschedule`, { startsAt: at(D, '16:30') })).status, 400);
  assert.equal((await partner.post(`${SPA()}/appointments/${apptB}/complete`)).status, 204);
  const done = await getAppt(SPA(), apptB);
  assert.equal(done.status, 'completed');
  assert.equal(done.completed_by_name, 'Spa Partner');
  const hold = (await ownerQuery('SELECT upper(during) - now() AS left FROM appointment_resource WHERE appointment_id = $1 LIMIT 1', [apptB])).rows[0];
  assert.ok(hold.left.minutes <= 15 && !hold.left.hours, 'held only for the clean-up buffer');
});

test('cancel needs a reason; no-show only after the start; both free the resources', async () => {
  assert.match((await partner.post(`${SPA()}/appointments/${apptA}/cancel`, {})).body.error, /reason/i);
  assert.match((await partner.post(`${SPA()}/appointments/${apptA}/no-show`)).body.error, /after the start/i);
  assert.equal((await partner.post(`${SPA()}/appointments/${apptA}/cancel`, { reason: 'Guest unwell' })).status, 204);
  const a = await getAppt(SPA(), apptA);
  assert.equal(a.status, 'cancelled');
  assert.equal(a.cancel_reason, 'Guest unwell');
  const again = await book(partner, SPA(), { serviceId: swedish.id, customerId: guest2.id, startsAt: at(D, '15:30') });
  assert.equal(again.status, 201, 'the cancelled slot can be booked again');
  const inbox = (await therapist.api.get('/api/notifications')).body.items;
  assert.ok(inbox.some((n) => n.title === 'Booking cancelled') || a.resources.every((r) => r.name !== 'Ada'));

  await startedAgo(again.body.id, 120);
  assert.equal((await partner.post(`${SPA()}/appointments/${again.body.id}/no-show`)).status, 204);
  assert.equal((await getAppt(SPA(), again.body.id)).status, 'no_show');
});

test('the database refuses a double booking even if the checks were bypassed', async () => {
  const r = await ownerQuery(
    `SELECT resource_id, during, business_unit_id FROM appointment_resource WHERE is_active LIMIT 1`);
  const row = r.rows[0];
  const other = (await ownerQuery(`SELECT id FROM appointment WHERE business_unit_id = $1 LIMIT 1`, [row.business_unit_id])).rows[0];
  await assert.rejects(ownerQuery(
    `INSERT INTO appointment_resource (appointment_id, business_unit_id, resource_id, role, during) VALUES ($1, $2, $3, 'x', $4)`,
    [other.id, row.business_unit_id, row.resource_id, row.during]), /resource_double_booked/);
});

test('every change is in the audit chain', async () => {
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
