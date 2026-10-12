import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, ownerQuery, asUser, staffMember } from './helpers.js';

let seed, owner, it, partner;
let each, water, oil;            // unit of measure, group item, spa-owned item
let fnbMain, barStore, spaStore; // stock locations
const FNB = () => `/api/inventory/${seed.units.FNB}`;
const SPA = () => `/api/inventory/${seed.units.SPA}`;
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  seed = await resetDatabase();
  [owner, it, partner] = await Promise.all([
    signIn('owner@test.local'), signIn('it@test.local'), signIn('partner@test.local')]);
  each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  const depts = (await owner.get('/api/org')).body.departments;
  const bar = depts.find((d) => d.name === 'Bar');

  water = (await owner.post('/api/catalog/items', { sku: 'WATER-75CL', name: 'Bottled water 75cl', baseUomId: each.id, isSellable: true })).body;
  oil = (await partner.post('/api/catalog/items', {
    sku: 'SPA-OIL-01', name: 'Massage oil', baseUomId: each.id, ownerBusinessUnitId: seed.units.SPA, isExpiryTracked: true,
  })).body;
  await owner.put(`/api/catalog/items/${water.id}/units/${seed.units.FNB}`, { sellPrice: 500, reorderLevel: 10 });
  await partner.put(`/api/catalog/items/${oil.id}/units/${seed.units.SPA}`, { reorderLevel: 2 });

  fnbMain = (await owner.post(`${FNB()}/locations`, { tier: 'branch', name: 'F&B Main Store', branchId: seed.branchId })).body;
  barStore = (await owner.post(`${FNB()}/locations`, {
    tier: 'department', name: 'Bar Store', branchId: seed.branchId, departmentId: bar.id, parentLocationId: fnbMain.id,
  })).body;
  spaStore = (await partner.post(`${SPA()}/locations`, { tier: 'branch', name: 'Spa Store', branchId: seed.branchId })).body;
});
after(closePools);

const post = (api, base, body) => api.post(`${base}/movements`, body);
const onHand = async (api, base, locationId, itemId) =>
  (await api.get(`${base}/balances?locationId=${locationId}&itemId=${itemId}`)).body
    .reduce((sum, b) => sum + Number(b.qty_on_hand), 0);

test('items: group items are managed by the owner, unit items by that unit', async () => {
  assert.equal(oil.is_batch_tracked, true, 'expiry tracking implies batch tracking');
  const items = (await partner.get('/api/catalog/items')).body;
  assert.ok(items.some((i) => i.id === water.id), 'partner can see group items');
  assert.equal((await partner.patch(`/api/catalog/items/${water.id}`, { name: 'Renamed', rowVersion: water.row_version })).status, 404);
  assert.equal((await owner.patch(`/api/catalog/items/${oil.id}`, { name: 'Renamed', rowVersion: oil.row_version })).status, 404);
  assert.equal((await partner.patch(`/api/catalog/items/${oil.id}`, { name: 'Massage oil (lavender)', rowVersion: oil.row_version })).status, 200);
});

test('locations follow the Branch → Department → Staff hierarchy', async () => {
  const cashier = await staffMember(owner, { email: 'cashier@test.local', role: 'STAFF', businessUnitId: seed.units.FNB });
  const wrong = await owner.post(`${FNB()}/locations`, {
    tier: 'staff', name: 'Bad holding', branchId: seed.branchId, staffUserId: cashier.userId, parentLocationId: fnbMain.id,
  });
  assert.equal(wrong.status, 400, 'staff holding cannot sit directly under a branch store');
  const ok = await owner.post(`${FNB()}/locations`, {
    tier: 'staff', name: 'Cashier float', branchId: seed.branchId, staffUserId: cashier.userId, parentLocationId: barStore.id,
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.department_id, barStore.department_id, 'staff holding inherits its department');
  assert.equal((await partner.post(`${FNB()}/locations`, { tier: 'branch', name: 'Rogue store', branchId: seed.branchId })).status, 403);
});

test('opening balance, transfer down the tiers, and no negative stock', async () => {
  assert.equal((await post(owner, FNB(), { type: 'opening_balance', itemId: water.id, qty: 20, toLocationId: fnbMain.id })).status, 400,
    'opening balance needs a cost');
  assert.equal((await post(owner, FNB(), { type: 'opening_balance', itemId: water.id, qty: 20, toLocationId: fnbMain.id, unitCost: 150 })).status, 201);
  assert.equal((await post(owner, FNB(), { type: 'transfer', itemId: water.id, qty: 5, fromLocationId: fnbMain.id, toLocationId: barStore.id })).status, 201);
  assert.equal(await onHand(owner, FNB(), fnbMain.id, water.id), 15);
  assert.equal(await onHand(owner, FNB(), barStore.id, water.id), 5);

  const tooMuch = await post(owner, FNB(), { type: 'issue', itemId: water.id, qty: 6, fromLocationId: barStore.id });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /not enough stock/);
  assert.equal(await onHand(owner, FNB(), barStore.id, water.id), 5, 'failed posting changed nothing');
});

test('wastage needs a valid reason; adjustments need a reason', async () => {
  assert.equal((await post(owner, FNB(), { type: 'wastage', itemId: water.id, qty: 1, fromLocationId: barStore.id, reason: 'oops' })).status, 400);
  assert.equal((await post(owner, FNB(), { type: 'wastage', itemId: water.id, qty: 1, fromLocationId: barStore.id, reason: 'spillage' })).status, 201);
  assert.equal((await post(owner, FNB(), { type: 'adjustment_out', itemId: water.id, qty: 1, fromLocationId: fnbMain.id })).status, 400);
  assert.equal(await onHand(owner, FNB(), barStore.id, water.id), 4);
});

test('batch-tracked items need batch number and expiry on the way in', async () => {
  assert.equal((await post(partner, SPA(), { type: 'opening_balance', itemId: oil.id, qty: 1, toLocationId: spaStore.id, unitCost: 1000 })).status, 400);
  assert.equal((await post(partner, SPA(), { type: 'opening_balance', itemId: oil.id, qty: 1, toLocationId: spaStore.id, unitCost: 1000, batchNo: 'X1' })).status, 400);
});

test('FEFO: issues draw the batch closest to expiry and never expired stock', async () => {
  const opening = (batchNo, qty, expiryDate) => post(partner, SPA(), {
    type: 'opening_balance', itemId: oil.id, qty, toLocationId: spaStore.id, unitCost: 2500, batchNo, expiryDate });
  assert.equal((await opening('A-LATE', 3, day(60))).status, 201);
  assert.equal((await opening('B-SOON', 2, day(10))).status, 201);
  assert.equal((await opening('C-EXPIRED', 4, day(-1))).status, 201);

  const issue = await post(partner, SPA(), { type: 'issue', itemId: oil.id, qty: 4, fromLocationId: spaStore.id });
  assert.equal(issue.status, 201);
  assert.equal(issue.body.movementIds.length, 2, 'split across two batches');
  const moves = (await partner.get(`${SPA()}/movements?itemId=${oil.id}&limit=2`)).body;
  assert.deepEqual(moves.map((m) => [m.batch_no, Number(m.qty)]).sort(), [['A-LATE', 2], ['B-SOON', 2]]);

  const short = await post(partner, SPA(), { type: 'issue', itemId: oil.id, qty: 2, fromLocationId: spaStore.id });
  assert.equal(short.status, 400, 'only 1 unexpired unit left; the 4 expired units are not used');

  const expired = (await partner.get(`${SPA()}/expiring?days=30`)).body;
  const cBatch = expired.find((e) => e.batch_no === 'C-EXPIRED');
  assert.equal(cBatch.is_expired, true);
  const writeOff = await post(partner, SPA(), {
    type: 'wastage', itemId: oil.id, qty: 4, fromLocationId: spaStore.id, batchId: cBatch.batch_id, reason: 'expiry' });
  assert.equal(writeOff.status, 201, 'an explicit batch can be written off even when expired');
});

test('partnership walls: owner reads Spa stock but cannot move it; partner cannot touch F&B', async () => {
  assert.ok((await owner.get(`${SPA()}/balances`)).body.length > 0);
  assert.equal((await post(owner, SPA(), { type: 'issue', itemId: oil.id, qty: 1, fromLocationId: spaStore.id })).status, 403);
  assert.deepEqual((await partner.get(`${FNB()}/balances`)).body, []);
  assert.equal((await post(partner, FNB(), { type: 'issue', itemId: water.id, qty: 1, fromLocationId: fnbMain.id })).status, 403);
  assert.deepEqual((await it.get(`${FNB()}/balances`)).body, [], 'IT sees no stock');
});

test('stock movements across units are refused', async () => {
  const res = await post(owner, FNB(), { type: 'transfer', itemId: water.id, qty: 1, fromLocationId: fnbMain.id, toLocationId: spaStore.id });
  assert.equal(res.status, 400);
});

test('unit cost is visible only to finance readers', async () => {
  const keeper = await staffMember(owner, { email: 'keeper@test.local', role: 'STOREKEEPER', businessUnitId: seed.units.FNB });
  const staff = await staffMember(owner, { email: 'runner@test.local', role: 'STAFF', businessUnitId: seed.units.FNB });
  const opening = (await keeper.api.get(`${FNB()}/movements?itemId=${water.id}`)).body.find((m) => m.movement_type === 'opening_balance');
  assert.equal(Number(opening.unit_cost), 150);
  const asStaff = (await staff.api.get(`${FNB()}/movements?itemId=${water.id}`)).body.find((m) => m.movement_type === 'opening_balance');
  assert.equal(asStaff.unit_cost, null);
  assert.equal((await keeper.api.post(`${FNB()}/movements`, {
    type: 'adjustment_in', itemId: water.id, qty: 1, toLocationId: fnbMain.id, reason: 'found' })).status, 403,
    'storekeepers move stock but cannot adjust it');
});

test('the ledger cannot be edited and balances cannot be written directly', async () => {
  await assert.rejects(ownerQuery('UPDATE stock_movement SET qty = 1000'), /append-only/);
  await assert.rejects(ownerQuery('DELETE FROM stock_movement'), /append-only/);
  await assert.rejects(
    asUser(seed.users.owner, seed.tenantId, `UPDATE stock_balance SET qty_on_hand = 999`),
    /permission denied/);
});

test('concurrent issues never oversell', async () => {
  await post(owner, FNB(), { type: 'adjustment_in', itemId: water.id, qty: 6, toLocationId: barStore.id, reason: 'restock' });
  assert.equal(await onHand(owner, FNB(), barStore.id, water.id), 10);
  const results = await Promise.all(Array.from({ length: 25 }, () =>
    post(owner, FNB(), { type: 'issue', itemId: water.id, qty: 1, fromLocationId: barStore.id })));
  assert.equal(results.filter((r) => r.status === 201).length, 10);
  assert.ok(results.every((r) => [201, 400].includes(r.status)), 'losers get a clean "not enough stock"');
  assert.equal(await onHand(owner, FNB(), barStore.id, water.id), 0);
});

test('summary flags low stock against the reorder level', async () => {
  const summary = (await owner.get(`${FNB()}/summary`)).body;
  const w = summary.find((s) => s.item_id === water.id);
  assert.equal(Number(w.on_hand), 15);
  assert.equal(w.is_low, false);
  await owner.put(`/api/catalog/items/${water.id}/units/${seed.units.FNB}`, { sellPrice: 500, reorderLevel: 20 });
  assert.equal((await owner.get(`${FNB()}/summary`)).body.find((s) => s.item_id === water.id).is_low, true);
});

test('every movement is in the audit log and the chain is intact', async () => {
  const { rows } = await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE entity = 'stock_movement'`);
  const moves = await ownerQuery('SELECT count(*)::int AS n FROM stock_movement');
  assert.equal(rows[0].n, moves.rows[0].n);
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
