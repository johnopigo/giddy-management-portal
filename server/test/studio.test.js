import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, staffMember, ownerQuery } from './helpers.js';

let seed, owner, desk, attendant;
let boothA, boothB, hire, ringLight, card, store, guest;
const S = () => `/api/bookings/${seed.units.STUDIO}`;
const day = (o) => { const d = new Date(Date.now() + 3600_000); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
const at = (date, hhmm) => `${date}T${hhmm}:00+01:00`;
const D = day(2);
const allDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: '00:00', closes: '24:00' }));
const tb = async () => Object.fromEntries((await owner.get(`/api/finance/${seed.units.STUDIO}/trial-balance`)).body
  .map((a) => [a.code, Number(a.balance)]));
const onHand = async () => (await owner.get(`/api/inventory/${seed.units.STUDIO}/balances?itemId=${card.id}&locationId=${store.id}`)).body
  .reduce((s, b) => s + Number(b.qty_on_hand), 0);
const get = async (id, api = desk.api) => (await api.get(`${S()}/appointments/${id}`)).body;
const pay = (id, body, api = desk.api) => api.post(`${S()}/appointments/${id}/bill`, { kind: 'payment', method: 'card', ...body });
const book = (body) => desk.api.post(`${S()}/appointments`, { serviceId: hire.id, customerId: guest.id, source: 'phone', ...body });
// Moves an appointment (and its holds) so that it started `mins` minutes ago.
const startedAgo = (id, mins) => ownerQuery(
  `WITH a AS (UPDATE appointment SET starts_at = date_trunc('minute', now()) - make_interval(mins => $2),
                ends_at = date_trunc('minute', now()) - make_interval(mins => $2) + (ends_at - starts_at) WHERE id = $1 RETURNING starts_at, ends_at)
   UPDATE appointment_resource SET during = tstzrange((SELECT starts_at FROM a), (SELECT ends_at FROM a)) WHERE appointment_id = $1`, [id, mins]);

before(async () => {
  seed = await resetDatabase();
  owner = await signIn('owner@test.local');
  desk = await staffMember(owner, { email: 'studio-desk@test.local', role: 'FRONT_DESK', businessUnitId: seed.units.STUDIO });
  attendant = await staffMember(owner, { email: 'attendant@test.local', role: 'STAFF', businessUnitId: seed.units.STUDIO });
  const res = async (name) => (await owner.post(`${S()}/resources`, { kind: 'booth', name, hours: allDay })).body;
  boothA = await res('Booth A');
  boothB = await res('Booth B');
  const h = await owner.post(`${S()}/services`, {
    code: 'BOOTH', name: 'Booth hire', mode: 'slot', durationMin: 60, minSlots: 1, maxSlots: 4, price: 20000, depositPct: 50,
    resources: [{ resourceId: boothA.id, role: 'booth' }, { resourceId: boothB.id, role: 'booth' }],
  });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  hire = h.body;
  const each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  ringLight = (await owner.post('/api/catalog/items', { sku: 'RING', name: 'Ring light hire', baseUomId: each.id, isSellable: true, isStockable: false })).body;
  card = (await owner.post('/api/catalog/items', { sku: 'SD64', name: 'Memory card 64GB', baseUomId: each.id, isSellable: true })).body;
  await owner.put(`/api/catalog/items/${ringLight.id}/units/${seed.units.STUDIO}`, { sellPrice: 5000 });
  await owner.put(`/api/catalog/items/${card.id}/units/${seed.units.STUDIO}`, { sellPrice: 8000 });
  store = (await owner.post(`/api/inventory/${seed.units.STUDIO}/locations`, { tier: 'branch', name: 'Studio store', branchId: seed.branchId })).body;
  await owner.post(`/api/inventory/${seed.units.STUDIO}/movements`, { type: 'opening_balance', itemId: card.id, qty: 10, toLocationId: store.id, unitCost: 3000 });
  guest = (await desk.api.post('/api/customers', { fullName: 'Kola Podcast', phone: '08032220000' })).body;
});
after(closePools);

let main;
test('a booking asks for its deposit and opens a bill', async () => {
  const r = await book({ startsAt: at(D, '10:00'), slots: 2, preferred: { booth: boothA.id } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  main = r.body.id;
  const a = await get(main);
  assert.equal(Number(a.price), 40000);
  assert.equal(Number(a.deposit_due), 20000);
  assert.match(a.bill.bill_number, /^BIL-STUDIO-\d{6}$/);
  assert.equal(a.bill.status, 'open');
  assert.equal(Number(a.bill.balance), 0);
  assert.equal(Number(a.bill.expected_total), 47300, '40,000 + 10% service + 7.5% VAT');
  const waiting = (await desk.api.get(`${S()}/appointments?money=deposit`)).body;
  assert.deepEqual(waiting.map((x) => x.id), [main]);
});

test('deposits are paid into the client ledger, never more than is owed', async () => {
  assert.equal((await pay(main, { amount: 20000, reference: 'POS-1001' })).status, 201);
  const a = await get(main);
  assert.equal(Number(a.paid), 20000);
  assert.equal(Number(a.bill.balance), -20000, 'a credit until the booking is charged');
  assert.equal((await desk.api.get(`${S()}/appointments?money=deposit`)).body.length, 0);
  const over = await pay(main, { amount: 30000 });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /27300/);
  const b = await tb();
  assert.equal(b['1010'], 20000);
  assert.equal(b['1100'], -20000);
});

test('add-ons: services and stock items; a stock item leaves the store and can be put back', async () => {
  assert.equal((await desk.api.post(`${S()}/appointments/${main}/addons`, { itemId: ringLight.id })).status, 201);
  const noStore = await desk.api.post(`${S()}/appointments/${main}/addons`, { itemId: card.id, qty: 2 });
  assert.equal(noStore.status, 400);
  assert.match(noStore.body.error, /choose the store/i);
  const cardLine = await desk.api.post(`${S()}/appointments/${main}/addons`, { itemId: card.id, qty: 2, locationId: store.id });
  assert.equal(cardLine.status, 201, JSON.stringify(cardLine.body));
  assert.equal(await onHand(), 8);
  let a = await get(main);
  assert.equal(Number(a.bill.balance), -20000 + 5912.5 + 18920);
  assert.equal((await tb())['5000'], 6000, 'cost of the cards sold');

  assert.equal((await desk.api.post(`/api/bookings/${seed.units.STUDIO}/bill-entries/${cardLine.body.id}/void`, { reason: 'Client brought own' })).status, 204);
  assert.equal(await onHand(), 10);
  a = await get(main);
  assert.equal(Number(a.bill.balance), -20000 + 5912.5);
  assert.ok(a.bill.entries.find((e) => e.id === cardLine.body.id).reversed);
  assert.equal((await desk.api.post(`/api/bookings/${seed.units.STUDIO}/bill-entries/${cardLine.body.id}/void`, { reason: 'again' })).status, 400);
  assert.equal((await tb())['5000'], 0);
});

test('an attendant who is not on the booking cannot see it or its bill', async () => {
  assert.equal((await attendant.api.get(`${S()}/appointments/${main}`)).status, 404);
  assert.equal((await pay(main, { amount: 100 }, attendant.api)).status, 404);
  assert.equal((await attendant.api.get(`${S()}/appointments`)).body.length, 0);
});

test('extending a hire while it runs, if the booth is free', async () => {
  await startedAgo(main, 10);
  assert.equal((await desk.api.post(`${S()}/appointments/${main}/check-in`)).status, 204);
  const a0 = await get(main);
  const blk = await owner.post(`${S()}/resources/${boothA.id}/blocks`, {
    from: a0.ends_at, to: new Date(new Date(a0.ends_at).getTime() + 30 * 60000).toISOString(), reason: 'Cleaning',
  });
  assert.equal(blk.status, 201, JSON.stringify(blk.body));
  const clash = await desk.api.post(`${S()}/appointments/${main}/extend`, { slots: 1 });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /Booth A is not free/);
  await owner.delete(`${S()}/blocks/${blk.body.id}`);
  assert.equal((await desk.api.post(`${S()}/appointments/${main}/extend`, { slots: 1 })).status, 204);
  const a = await get(main);
  assert.equal(a.slots, 3);
  assert.equal(Number(a.price), 60000);
  assert.equal(new Date(a.ends_at) - new Date(a0.ends_at), 3600_000);
  assert.equal((await desk.api.post(`${S()}/appointments/${main}/extend`, { slots: 2 })).status, 400, 'four slots at most');
});

test('completing charges the booking; a manager adjusts; paying the balance closes the bill', async () => {
  assert.equal((await desk.api.post(`${S()}/appointments/${main}/complete`)).status, 204);
  let a = await get(main);
  assert.equal(Number(a.bill.balance), 70950 + 5912.5 - 20000);
  assert.ok(a.bill.entries.some((e) => e.entry_type === 'booking' && Number(e.amount) === 60000));
  assert.deepEqual((await desk.api.get(`${S()}/appointments?money=owing`)).body.map((x) => x.id), [main]);

  const deskAdjust = await desk.api.post(`${S()}/appointments/${main}/bill`, { kind: 'adjustment', amount: 862.5, description: 'Goodwill' });
  assert.equal(deskAdjust.status, 403);
  assert.equal((await owner.post(`${S()}/appointments/${main}/bill`, { kind: 'adjustment', amount: 862.5, description: 'Goodwill' })).status, 201);
  assert.equal((await pay(main, { amount: 56001, method: 'cash' })).status, 400, 'no overpaying');
  assert.equal((await pay(main, { amount: 56000, method: 'cash' })).status, 201);
  a = await get(main);
  assert.equal(a.bill.status, 'closed');
  assert.equal((await pay(main, { amount: 1 })).status, 400, 'closed');

  const b = await tb();
  assert.equal(b['1100'], 0);
  assert.equal(b['4300'], -59137.5);
  assert.equal(b['4000'], -5000);
  assert.equal(b['4100'], -6500);
  assert.equal(b['2100'], -5362.5);
  assert.equal(b['1000'], 56000);
  assert.equal(b['1010'], 20000);
});

test('cancelling: refund the deposit, or keep it as a fee', async () => {
  const r = (await book({ startsAt: at(D, '15:00') })).body;
  assert.equal((await pay(r.id, { amount: 10000, method: 'transfer' })).status, 201);
  const refuse = await desk.api.post(`${S()}/appointments/${r.id}/cancel`, { reason: 'Changed plans' });
  assert.equal(refuse.status, 400);
  assert.match(refuse.body.error, /refund the deposit/i);
  assert.equal((await desk.api.post(`${S()}/appointments/${r.id}/cancel`, { reason: 'Late cancellation', keepDeposit: true })).status, 204);
  const a = await get(r.id);
  assert.equal(a.status, 'cancelled');
  assert.equal(a.bill.status, 'closed');
  assert.ok(a.bill.entries.some((e) => e.entry_type === 'fee' && Number(e.amount) === 10000));

  const r2 = (await book({ startsAt: at(D, '17:00') })).body;
  await pay(r2.id, { amount: 10000 });
  assert.equal((await desk.api.post(`${S()}/appointments/${r2.id}/bill`, { kind: 'refund', amount: 10001, method: 'card' })).status, 400);
  assert.equal((await desk.api.post(`${S()}/appointments/${r2.id}/bill`, { kind: 'refund', amount: 10000, method: 'card' })).status, 201);
  assert.equal((await desk.api.post(`${S()}/appointments/${r2.id}/cancel`, { reason: 'Rain' })).status, 204);
  assert.equal((await get(r2.id)).bill.status, 'closed');

  const r3 = (await book({ startsAt: at(D, '19:00') })).body;
  await startedAgo(r3.id, 200);
  assert.equal((await desk.api.post(`${S()}/appointments/${r3.id}/no-show`)).status, 204);
  assert.equal((await get(r3.id)).bill.status, 'closed', 'nothing paid, nothing owed');

  const b = await tb();
  assert.equal(b['4300'], -59137.5 - 10000);
  assert.equal(b['1100'], 0);
});

test('service deposit percentage is part of the setup', async () => {
  const setup = (await owner.get(`${S()}/setup`)).body;
  assert.equal(Number(setup.services[0].deposit_pct), 50);
  assert.equal((await owner.patch(`${S()}/services/${hire.id}`, { depositPct: 100 })).status, 204);
  assert.equal(Number((await owner.get(`${S()}/setup`)).body.services[0].deposit_pct), 100);
});

test('every change is in the audit chain', async () => {
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
