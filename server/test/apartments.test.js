import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, staffMember } from './helpers.js';

let seed, owner, partner, desk, keeper, cashier;
let std, dlx, r101, r102, r201, guestA, guestB, guestC, corkage, bar, barStore;
const A = () => `/api/apartments/${seed.units.APARTMENTS}`;
const day = (o) => { const d = new Date(Date.now() + 3600_000); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
const tb = async (unit) => Object.fromEntries((await owner.get(`/api/finance/${seed.units[unit]}/trial-balance`)).body.map((a) => [a.code, Number(a.balance)]));
const sum = (b) => Math.round(Object.values(b).reduce((s, v) => s + v, 0) * 100) / 100;

before(async () => {
  seed = await resetDatabase();
  [owner, partner] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local')]);
  const depts = (await owner.get('/api/org')).body.departments;
  bar = depts.find((d) => d.name === 'Bar');
  desk = await staffMember(owner, { email: 'desk@test.local', role: 'FRONT_DESK', businessUnitId: seed.units.APARTMENTS });
  keeper = await staffMember(owner, { email: 'keeper@test.local', role: 'STAFF', businessUnitId: seed.units.APARTMENTS });
  cashier = await staffMember(owner, { email: 'cashier@test.local', role: 'CASHIER', businessUnitId: seed.units.FNB, departmentId: bar.id });

  std = (await owner.post(`${A()}/room-types`, { code: 'STD', name: 'Standard', baseRate: 50000 })).body;
  dlx = (await owner.post(`${A()}/room-types`, { code: 'DLX', name: 'Deluxe suite', baseRate: 80000, maxAdults: 3 })).body;
  const room = async (n, t) => (await owner.post(`${A()}/rooms`, { roomNumber: n, roomTypeId: t.id, branchId: seed.branchId, floor: n[0] })).body;
  r101 = await room('101', std); r102 = await room('102', std); r201 = await room('201', dlx);
  await owner.post(`${A()}/rate-plans`, { roomTypeId: dlx.id, name: 'Festive', dateFrom: day(30), dateTo: day(31), nightlyRate: 100000, priority: 5 });
  const guest = async (name, phone) => (await desk.api.post('/api/customers', { fullName: name, phone })).body;
  guestA = await guest('Amaka Eze', '08030000001');
  guestB = await guest('Bola Ade', '08030000002');
  guestC = await guest('Chidi Obi', '08030000003');

  const each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  corkage = (await owner.post('/api/catalog/items', { sku: 'CORK', name: 'Corkage', baseUomId: each.id, isSellable: true, isStockable: false })).body;
  await owner.put(`/api/catalog/items/${corkage.id}/units/${seed.units.FNB}`, { sellPrice: 2000 });
  barStore = (await owner.post(`/api/inventory/${seed.units.FNB}/locations`, { tier: 'branch', name: 'Bar', branchId: seed.branchId })).body;
});
after(closePools);

const book = (api, body) => api.post(`${A()}/reservations`, { source: 'direct', ...body });
const getRes = async (id, api = desk.api) => (await api.get(`${A()}/reservations/${id}`)).body;

let resA, resB, resD;
test('availability and auto-assigned bookings; no room is given twice', async () => {
  const avail = (await desk.api.get(`${A()}/availability?checkIn=${day(0)}&checkOut=${day(3)}`)).body;
  const s = avail.find((a) => a.code === 'STD');
  assert.deepEqual(s.free_rooms.map((r) => r.room_number), ['101', '102']);
  assert.equal(Number(s.stay_total), 150000);

  resA = (await book(desk.api, { customerId: guestA.id, checkIn: day(0), checkOut: day(3), rooms: [{ roomTypeId: std.id }] })).body.id;
  resB = (await book(desk.api, { customerId: guestB.id, checkIn: day(1), checkOut: day(2), rooms: [{ roomTypeId: std.id }] })).body.id;
  assert.equal((await getRes(resA)).rooms[0].room_number, '101');
  assert.equal((await getRes(resB)).rooms[0].room_number, '102');
  const full = await book(desk.api, { customerId: guestC.id, checkIn: day(1), checkOut: day(2), rooms: [{ roomTypeId: std.id }] });
  assert.equal(full.status, 400);
  assert.match(full.body.error, /no Standard room is free/);
  assert.match((await getRes(resA)).booking_ref, /^RES-APARTMENTS-/);
});

test('eight people booking the same room at once: exactly one wins', async () => {
  const attempts = await Promise.all(Array.from({ length: 8 }, () =>
    book(desk.api, { customerId: guestC.id, checkIn: day(10), checkOut: day(12), rooms: [{ roomTypeId: dlx.id, roomId: r201.id }] })));
  assert.equal(attempts.filter((r) => r.status === 201).length, 1);
  assert.ok(attempts.filter((r) => r.status !== 201).every((r) => r.status === 409 && /already booked/.test(r.body.error)));
  resD = attempts.find((r) => r.status === 201).body.id;
});

test('rate plans price the nights they cover', async () => {
  const avail = (await desk.api.get(`${A()}/availability?checkIn=${day(29)}&checkOut=${day(32)}`)).body;
  assert.equal(Number(avail.find((a) => a.code === 'DLX').stay_total), 80000 + 100000 + 100000);
});

test('check-in: not before arrival; the room becomes occupied', async () => {
  assert.equal((await desk.api.post(`${A()}/reservations/${resB}/check-in`)).status, 400, 'arrives tomorrow');
  assert.equal((await desk.api.post(`${A()}/reservations/${resA}/check-in`)).status, 204);
  const board = (await desk.api.get(`${A()}/board`)).body;
  const r = board.find((x) => x.room_number === '101');
  assert.equal(r.status, 'occupied');
  assert.equal(r.guest_name, 'Amaka Eze');
  const today = await desk.api.get(`${A()}/today`);
  assert.equal(today.status, 200);
  assert.ok(today.body.inHouse.some((x) => x.id === resA));
});

test('night audit charges the night with service charge and VAT, once', async () => {
  assert.equal((await desk.api.post(`${A()}/night-audit`)).body.nightsCharged, 1);
  assert.equal((await desk.api.post(`${A()}/night-audit`)).body.nightsCharged, 0, 'idempotent');
  const f = (await getRes(resA)).folio;
  // 50,000 + 10% service 5,000 + 7.5% VAT on 55,000 = 4,125 → 59,125
  assert.equal(f.balance, 59125);
  const b = await tb('APARTMENTS');
  assert.equal(b['1100'], 59125);
  assert.equal(b['4200'], -50000);
});

let barTicket;
test('charge to room from the bar: the guest owes Apartments, Apartments owes F&B', async () => {
  const inHouse = (await cashier.api.get('/api/apartments/in-house')).body;
  const amaka = inHouse.find((g) => g.guest_name === 'Amaka Eze');
  assert.equal(amaka.room_numbers, '101');
  const sale = await cashier.api.post(`/api/pos/${seed.units.FNB}/checkout`, {
    departmentId: bar.id, locationId: barStore.id, lines: [{ itemId: corkage.id, qty: 1 }],
    payments: [{ method: 'room', amount: 2365, reservationId: amaka.reservation_id }] });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  barTicket = sale.body.id;
  const f = (await getRes(resA)).folio;
  assert.equal(f.balance, 59125 + 2365);
  assert.equal(f.entries.at(-1).source_unit_name, 'Food & Beverage');

  const fnb = await tb('FNB');
  assert.equal(fnb['1150'], 2365, 'F&B: due from Apartments');
  assert.equal(fnb['1000'] ?? 0, 0, 'no cash taken');
  const apt = await tb('APARTMENTS');
  assert.equal(apt['2200'], -2365, 'Apartments: due to F&B');
  assert.equal(sum(fnb), 0);
  assert.equal(sum(apt), 0);
});

test('charging a guest who is not checked in is refused', async () => {
  const sale = await cashier.api.post(`/api/pos/${seed.units.FNB}/checkout`, {
    departmentId: bar.id, locationId: barStore.id, lines: [{ itemId: corkage.id, qty: 1 }],
    payments: [{ method: 'room', amount: 2365, reservationId: resB }] });
  assert.equal(sale.status, 400);
  assert.match(sale.body.error, /not checked in/);
});

test('the Spa can charge rooms but never sees the guest bill', async () => {
  assert.ok((await partner.get('/api/apartments/in-house')).body.length >= 1);
  assert.equal((await partner.get(`${A()}/reservations/${resA}`)).status, 404);
  assert.deepEqual((await partner.get(`${A()}/reservations`)).body, []);
  assert.equal((await book(partner, { customerId: guestC.id, checkIn: day(5), checkOut: day(6), rooms: [{ roomTypeId: std.id }] })).status, 403);
});

test('voiding the bar ticket takes the charge back off the guest bill', async () => {
  assert.equal((await owner.post(`/api/pos/${seed.units.FNB}/tickets/${barTicket}/void`, { reason: 'Wrong room' })).status, 204);
  assert.equal((await getRes(resA)).folio.balance, 59125);
  assert.equal((await tb('FNB'))['1150'], 0);
  assert.equal((await tb('APARTMENTS'))['2200'], 0);
});

test('folio rules: adjustments need a manager; refunds only of a credit', async () => {
  const fid = (await getRes(resA)).folio.id;
  assert.equal((await desk.api.post(`${A()}/folios/${fid}`, { kind: 'adjustment', description: 'Goodwill', amount: 1000 })).status, 403);
  assert.equal((await owner.post(`${A()}/folios/${fid}`, { kind: 'adjustment', description: 'Goodwill: slow wifi', amount: 1000 })).status, 201);
  assert.equal((await desk.api.post(`${A()}/folios/${fid}`, { kind: 'refund', amount: 10, method: 'cash' })).status, 400);
  assert.equal((await desk.api.post(`${A()}/folios/${fid}`, { kind: 'charge', description: 'Laundry', amount: 3000 })).status, 201);
  assert.equal((await getRes(resA)).folio.balance, 59125 - 1000 + 3000 + 300 + 247.5);
});

test('check-out needs a settled bill; an early departure releases the remaining nights', async () => {
  const r = await getRes(resA);
  assert.equal((await desk.api.post(`${A()}/reservations/${resA}/check-out`)).status, 400);
  assert.equal((await desk.api.post(`${A()}/folios/${r.folio.id}`, { kind: 'payment', amount: r.folio.balance, method: 'card', reference: 'POS-1' })).status, 201);
  assert.equal((await desk.api.post(`${A()}/reservations/${resA}/check-out`)).status, 204);
  const after = await getRes(resA);
  assert.equal(after.status, 'checked_out');
  assert.equal(after.check_out, day(1), 'left after one night');
  assert.equal(after.folio.status, 'closed');
  assert.equal(after.rooms[0].room_status, 'cleaning');
  const avail = (await desk.api.get(`${A()}/availability?checkIn=${day(1)}&checkOut=${day(3)}`)).body;
  assert.ok(avail.find((a) => a.code === 'STD').free_rooms.some((x) => x.room_number === '101'), 'nights released');
  assert.equal(sum(await tb('APARTMENTS')), 0);
});

test('housekeeping: assigned housekeeper finishes the clean and the room is available again', async () => {
  const task = (await desk.api.get(`${A()}/housekeeping`)).body.find((t) => t.room_number === '101');
  assert.equal(task.task_type, 'clean');
  assert.equal((await keeper.api.post(`${A()}/housekeeping/${task.id}`, { status: 'done' })).status, 403, 'not assigned yet');
  assert.equal((await desk.api.post(`${A()}/housekeeping/${task.id}`, { assignedTo: keeper.userId })).status, 204);
  assert.equal((await keeper.api.post(`${A()}/housekeeping/${task.id}`, { status: 'done' })).status, 204);
  assert.equal((await desk.api.get(`${A()}/board`)).body.find((x) => x.room_number === '101').status, 'available');
});

test('cancelling: a paid deposit must be refunded first; no-shows only after arrival day', async () => {
  const fid = (await getRes(resB)).folio.id;
  await desk.api.post(`${A()}/folios/${fid}`, { kind: 'payment', amount: 20000, method: 'transfer', description: 'Deposit' });
  assert.equal((await desk.api.post(`${A()}/reservations/${resB}/no-show`)).status, 400);
  assert.equal((await desk.api.post(`${A()}/reservations/${resB}/cancel`, { reason: 'Plans changed' })).status, 400);
  assert.equal((await desk.api.post(`${A()}/folios/${fid}`, { kind: 'refund', amount: 20000, method: 'transfer' })).status, 201);
  assert.equal((await desk.api.post(`${A()}/reservations/${resB}/cancel`, { reason: 'Plans changed' })).status, 204);
  const again = await book(desk.api, { customerId: guestC.id, checkIn: day(1), checkOut: day(2), rooms: [{ roomTypeId: std.id, roomId: r102.id }] });
  assert.equal(again.status, 201, 'room 102 is free again');
});

test('extending into a night that is taken is refused; a free night is fine', async () => {
  const other = await book(desk.api, { customerId: guestA.id, checkIn: day(12), checkOut: day(13), rooms: [{ roomTypeId: dlx.id, roomId: r201.id }] });
  assert.equal(other.status, 201);
  const clash = await desk.api.post(`${A()}/reservations/${resD}/extend`, { checkOut: day(13) });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /room 201 is already booked/i);
  assert.equal((await desk.api.post(`/api/apartments/${seed.units.APARTMENTS}/reservations/${other.body.id}/extend`, { checkOut: day(14) })).status, 204);
});

test('room status: front desk takes a room out of order; housekeepers cannot', async () => {
  assert.equal((await keeper.api.post(`${A()}/rooms/${r102.id}/status`, { status: 'out_of_order' })).status, 403);
  assert.equal((await desk.api.post(`${A()}/rooms/${r102.id}/status`, { status: 'out_of_order', note: 'Leak' })).status, 204);
  const avail = (await desk.api.get(`${A()}/availability?checkIn=${day(40)}&checkOut=${day(41)}`)).body;
  assert.ok(!avail.find((a) => a.code === 'STD').free_rooms.some((x) => x.room_number === '102'));
  assert.equal((await desk.api.post(`${A()}/rooms/${r102.id}/status`, { status: 'occupied' })).status, 400);
});

test('only managers configure rooms and rates', async () => {
  assert.equal((await desk.api.post(`${A()}/room-types`, { code: 'PH', name: 'Penthouse', baseRate: 1 })).status, 403);
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
