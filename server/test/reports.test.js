// Group reports: figures come from the books and the operational records, and every reader sees
// only the units whose finances they may read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, staffMember, ownerQuery } from './helpers.js';

let seed, owner, partner, it, cashier, from, to;
const day = (o) => { const d = new Date(Date.now() + 3600_000); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
const report = (api, extra = '') => api.get(`/api/reports/summary?from=${from}&to=${to}${extra}`);
const unit = (r, code) => r.body.units.find((u) => u.code === code);

before(async () => {
  seed = await resetDatabase();
  [owner, partner, it] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local'), signIn('it@test.local')]);
  const org = (await owner.get('/api/org')).body;
  const bar = org.departments.find((d) => d.name === 'Bar');
  cashier = await staffMember(owner, { email: 'cashier@test.local', role: 'CASHIER', businessUnitId: seed.units.FNB, departmentId: bar.id });

  // F&B: two bottles of water at the bar (cost 450 each).
  const each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  const water = (await owner.post('/api/catalog/items', { sku: 'WATER', name: 'Water', baseUomId: each.id, isSellable: true })).body;
  await owner.put(`/api/catalog/items/${water.id}/units/${seed.units.FNB}`, { sellPrice: 800 });
  const store = (await owner.post(`/api/inventory/${seed.units.FNB}/locations`, { tier: 'branch', name: 'Bar', branchId: seed.branchId })).body;
  await owner.post(`/api/inventory/${seed.units.FNB}/movements`, { type: 'opening_balance', itemId: water.id, qty: 20, toLocationId: store.id, unitCost: 450 });
  const sale = await cashier.api.post(`/api/pos/${seed.units.FNB}/checkout`, {
    departmentId: bar.id, locationId: store.id, lines: [{ itemId: water.id, qty: 2 }], payments: [{ method: 'cash', amount: 1892 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  // Apartments: one night in one of two rooms, charged by the night audit and paid by card.
  const A = `/api/apartments/${seed.units.APARTMENTS}`;
  const std = (await owner.post(`${A}/room-types`, { code: 'STD', name: 'Standard', baseRate: 50000 })).body;
  for (const n of ['101', '102']) await owner.post(`${A}/rooms`, { roomNumber: n, roomTypeId: std.id, branchId: seed.branchId });
  const guest = (await owner.post('/api/customers', { fullName: 'Amaka Eze', phone: '08030000001' })).body;
  const res = (await owner.post(`${A}/reservations`, { customerId: guest.id, checkIn: day(0), checkOut: day(1), rooms: [{ roomTypeId: std.id }] })).body;
  assert.equal((await owner.post(`${A}/reservations/${res.id}/check-in`)).status, 204);
  assert.equal((await owner.post(`${A}/night-audit`, {})).status, 200);
  const folio = (await owner.get(`${A}/reservations/${res.id}`)).body.folio;
  assert.equal((await owner.post(`${A}/folios/${folio.id}`, { kind: 'payment', amount: 59125, method: 'card' })).status, 201);

  // Studio: a two-hour hire, completed and not yet paid.
  const S = `/api/bookings/${seed.units.STUDIO}`;
  const allDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: '00:00', closes: '24:00' }));
  const booth = (await owner.post(`${S}/resources`, { kind: 'booth', name: 'Booth A', hours: allDay })).body;
  const hire = (await owner.post(`${S}/services`, { code: 'BOOTH', name: 'Booth hire', mode: 'slot', durationMin: 60, maxSlots: 4, price: 10000,
    resources: [{ resourceId: booth.id, role: 'booth' }] })).body;
  const appt = (await owner.post(`${S}/appointments`, { serviceId: hire.id, customerId: guest.id, startsAt: `${day(3)}T10:00:00+01:00`, slots: 2, source: 'online' })).body;
  await ownerQuery(
    `WITH a AS (UPDATE appointment SET starts_at = date_trunc('minute', now()) - interval '30 minutes', ends_at = date_trunc('minute', now()) + interval '90 minutes'
                 WHERE id = $1 RETURNING starts_at, ends_at)
     UPDATE appointment_resource SET during = tstzrange((SELECT starts_at FROM a), (SELECT ends_at FROM a)) WHERE appointment_id = $1`, [appt.id]);
  assert.equal((await owner.post(`${S}/appointments/${appt.id}/check-in`)).status, 204);
  assert.equal((await owner.post(`${S}/appointments/${appt.id}/complete`)).status, 204);

  // A three-day window around today, whatever the server's clock zone.
  const today = (await ownerQuery('SELECT current_date::text AS d')).rows[0].d;
  const shift = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  [from, to] = [shift(today, -1), shift(today, 1)];
});
after(closePools);

test('the Owner sees the whole group, unit by unit, straight from the books', async () => {
  const r = await report(owner);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.units.map((u) => u.code), ['APARTMENTS', 'FNB', 'STUDIO', 'SPA']);
  const fnb = unit(r, 'FNB');
  assert.deepEqual([fnb.net, fnb.serviceCharge, fnb.vat, fnb.cogs, fnb.grossProfit], [1600, 160, 132, 900, 700]);
  assert.equal(fnb.marginPct, 43.8);
  assert.equal(fnb.takings.cash, 1892);
  assert.equal(fnb.stockValue, 18 * 450);
  const apt = unit(r, 'APARTMENTS');
  assert.equal(apt.net, 50000);
  assert.equal(apt.takings.card, 59125);
  assert.equal(apt.openBills, 0, 'the stay is paid');
  const studio = unit(r, 'STUDIO');
  assert.equal(studio.net, 20000);
  assert.equal(studio.openBills, 23650, 'the hire is completed but unpaid');
  assert.deepEqual(r.body.totals, {
    net: 71600, serviceCharge: 160 + 5000 + 2000, vat: 132 + 4125 + 1650, cogs: 900, grossProfit: 70700,
    takings: 1892 + 59125, openBills: 23650, stockValue: 8100,
  });
});

test('apartments: occupancy, average daily rate and revenue per available room', async () => {
  const occ = (await report(owner)).body.occupancy[0];
  assert.deepEqual([occ.rooms, occ.availableNights, occ.nightsSold], [2, 6, 1]);
  assert.equal(occ.occupancyPct, 16.7);
  assert.equal(occ.adr, 50000);
  assert.equal(occ.revpar, 8333.33);
});

test('appointments, daily series and best sellers', async () => {
  const r = (await report(owner)).body;
  const studio = r.appointments.find((a) => a.unit_name === 'Content Studio');
  assert.deepEqual([studio.completed, studio.online, studio.revenue], [1, 1, 20000]);
  assert.equal(r.daily.reduce((s, d) => s + d.net, 0), 71600);
  assert.equal(r.topItems[0].item_name, 'Water');
  assert.deepEqual([r.topItems[0].qty, r.topItems[0].net], [2, 1600]);
});

test('everyone sees only the units whose finances they may read', async () => {
  assert.deepEqual((await report(partner)).body.units.map((u) => u.code), ['SPA']);
  assert.deepEqual((await report(cashier.api)).body.units.map((u) => u.code), ['FNB']);
  assert.deepEqual((await report(it)).body.units, []);
  assert.deepEqual((await report(owner, `&unitId=${seed.units.STUDIO}`)).body.units.map((u) => u.code), ['STUDIO']);
});

test('periods must be sensible', async () => {
  assert.equal((await owner.get(`/api/reports/summary?from=${to}&to=${from}`)).status, 400);
  assert.equal((await owner.get(`/api/reports/summary?from=2024-01-01&to=2026-01-01`)).status, 400);
});
