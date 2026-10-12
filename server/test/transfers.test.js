import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools } from './helpers.js';

let seed, owner, partner, water, fnbMain, spaStore;
const onHand = async (api, bu, itemId) => (await api.get(`/api/inventory/${bu}/balances?itemId=${itemId}`)).body
  .reduce((s, b) => s + Number(b.qty_on_hand), 0);

before(async () => {
  seed = await resetDatabase();
  [owner, partner] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local')]);
  const each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  water = (await owner.post('/api/catalog/items', { sku: 'WATER', name: 'Water', baseUomId: each.id })).body;
  await owner.put(`/api/catalog/items/${water.id}/units/${seed.units.FNB}`, {});
  fnbMain = (await owner.post(`/api/inventory/${seed.units.FNB}/locations`, { tier: 'branch', name: 'Main', branchId: seed.branchId })).body;
  spaStore = (await partner.post(`/api/inventory/${seed.units.SPA}/locations`, { tier: 'branch', name: 'Spa Store', branchId: seed.branchId })).body;
  await owner.post(`/api/inventory/${seed.units.FNB}/movements`, { type: 'opening_balance', itemId: water.id, qty: 20, toLocationId: fnbMain.id, unitCost: 450 });
});
after(closePools);

const send = (qty) => owner.post('/api/transfers', {
  fromBusinessUnitId: seed.units.FNB, toBusinessUnitId: seed.units.SPA, fromLocationId: fnbMain.id,
  lines: [{ itemId: water.id, qty }] });

test('the receiving unit must stock the item first', async () => {
  const res = await send(5);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /does not stock this item/);
  assert.equal(await onHand(owner, seed.units.FNB, water.id), 20, 'nothing left the store');
});

test('dispatch → in transit → partner accepts into a Spa store at the same cost', async () => {
  await partner.put(`/api/catalog/items/${water.id}/units/${seed.units.SPA}`, {});
  const res = await send(5);
  assert.equal(res.status, 201);
  assert.equal(await onHand(owner, seed.units.FNB, water.id), 15);

  const seen = (await partner.get('/api/transfers')).body.find((t) => t.id === res.body.id);
  assert.equal(seen.status, 'in_transit');
  assert.equal(seen.from_location_name, null, "partner does not see F&B's store names");
  assert.equal(seen.can_receive, true);
  assert.ok((await partner.get('/api/notifications')).body.items.some((n) => n.kind === 'transfer_incoming'));

  assert.equal((await owner.post(`/api/transfers/${res.body.id}/receive`, { toLocationId: spaStore.id })).status, 403,
    'the owner cannot receive into the Spa');
  assert.equal((await partner.post(`/api/transfers/${res.body.id}/receive`, { toLocationId: spaStore.id })).status, 204);
  assert.equal(await onHand(partner, seed.units.SPA, water.id), 5);
  const val = (await partner.get(`/api/inventory/${seed.units.SPA}/valuation`)).body.find((v) => v.item_id === water.id);
  assert.equal(Number(val.avg_unit_cost), 450, 'cost travels with the stock');
  assert.equal((await partner.post(`/api/transfers/${res.body.id}/receive`, { toLocationId: spaStore.id })).status, 400, 'only once');
});

test('refused transfers go back to the sender', async () => {
  const res = await send(3);
  assert.equal(await onHand(owner, seed.units.FNB, water.id), 12);
  assert.equal((await partner.post(`/api/transfers/${res.body.id}/reject`, { reason: 'Not ordered' })).status, 204);
  assert.equal((await partner.post(`/api/transfers/${res.body.id}/return`)).status, 403, 'only the sender puts it back');
  assert.equal((await owner.post(`/api/transfers/${res.body.id}/return`)).status, 204);
  assert.equal(await onHand(owner, seed.units.FNB, water.id), 15);
  assert.equal((await owner.get('/api/transfers')).body.find((t) => t.id === res.body.id).status, 'returned');
});

test('the partner cannot send stock out of F&B', async () => {
  const res = await partner.post('/api/transfers', {
    fromBusinessUnitId: seed.units.FNB, toBusinessUnitId: seed.units.SPA, fromLocationId: fnbMain.id,
    lines: [{ itemId: water.id, qty: 1 }] });
  assert.equal(res.status, 403);
});

test('more than is on hand cannot be sent', async () => {
  const res = await send(100);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not enough stock/);
});
