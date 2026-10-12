import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, staffMember } from './helpers.js';

let seed, owner, partner, manager, cashier, cook;
let fanta, sprite, grenadine, chapman, rice, oil, jollof, barStore, kitchenStore, pass, bar, oilSpa;
const R = () => `/api/recipes/${seed.units.FNB}`;
const PR = () => `/api/production/${seed.units.FNB}`;
const INV = () => `/api/inventory/${seed.units.FNB}`;

before(async () => {
  seed = await resetDatabase();
  [owner, partner] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local')]);
  const depts = (await owner.get('/api/org')).body.departments;
  bar = depts.find((d) => d.name === 'Bar');
  const kitchen = depts.find((d) => d.name === 'Kitchen');
  manager = await staffMember(owner, { email: 'manager@test.local', role: 'UNIT_MANAGER', businessUnitId: seed.units.FNB });
  cashier = await staffMember(owner, { email: 'cashier@test.local', role: 'CASHIER', businessUnitId: seed.units.FNB, departmentId: bar.id });
  cook = await staffMember(owner, { email: 'cook@test.local', role: 'STOREKEEPER', businessUnitId: seed.units.FNB });

  const uom = async (code, name) => (await owner.post('/api/catalog/uoms', { code, name })).body;
  const [bottle, ml, kg, l, portion, each] = await Promise.all([
    uom('bottle', 'Bottle'), uom('ml', 'Millilitre'), uom('kg', 'Kilogram'), uom('l', 'Litre'), uom('portion', 'Portion'), uom('each', 'Each')]);
  const item = async (sku, name, baseUomId, extra = {}) => {
    const it = (await owner.post('/api/catalog/items', { sku, name, baseUomId, ...extra })).body;
    await owner.put(`/api/catalog/items/${it.id}/units/${seed.units.FNB}`, { sellPrice: extra.price ?? null });
    return it;
  };
  fanta = await item('FANTA', 'Fanta', bottle.id);
  sprite = await item('SPRITE', 'Sprite', bottle.id);
  grenadine = await item('GRENADINE', 'Grenadine', ml.id);
  chapman = await item('CHAPMAN', 'Chapman', each.id, { isSellable: true, isStockable: false, price: 3500 });
  rice = await item('RICE', 'Rice', kg.id);
  oil = await item('OIL', 'Vegetable oil', l.id);
  jollof = await item('JOLLOF', 'Jollof rice', portion.id, { isSellable: true, price: 4000 });

  const main = (await owner.post(`${INV()}/locations`, { tier: 'branch', name: 'Main', branchId: seed.branchId })).body;
  barStore = (await owner.post(`${INV()}/locations`, { tier: 'department', name: 'Bar', branchId: seed.branchId, departmentId: bar.id, parentLocationId: main.id })).body;
  kitchenStore = (await owner.post(`${INV()}/locations`, { tier: 'department', name: 'Kitchen store', branchId: seed.branchId, departmentId: kitchen.id, parentLocationId: main.id })).body;
  pass = (await owner.post(`${INV()}/locations`, { tier: 'department', name: 'Kitchen pass', branchId: seed.branchId, departmentId: kitchen.id, parentLocationId: main.id })).body;
  const open = (it, qty, cost, loc) => owner.post(`${INV()}/movements`, { type: 'opening_balance', itemId: it.id, qty, toLocationId: loc.id, unitCost: cost });
  await open(fanta, 10, 400, barStore);
  await open(sprite, 10, 400, barStore);
  await open(grenadine, 1000, 5, barStore);
  await open(rice, 10, 1500, kitchenStore);
  await open(oil, 5, 2000, kitchenStore);

  const spaUnit = await partner.post('/api/catalog/uoms', { code: 'bottle_s', name: 'Spa bottle' });
  oilSpa = (await partner.post('/api/catalog/items', { sku: 'SPAOIL', name: 'Massage oil', baseUomId: spaUnit.body.id, ownerBusinessUnitId: seed.units.SPA })).body;
  await partner.put(`/api/catalog/items/${oilSpa.id}/units/${seed.units.SPA}`, {});
});
after(closePools);

const qtyAt = async (it, loc) => (await owner.get(`${INV()}/balances?itemId=${it.id}&locationId=${loc.id}`)).body
  .reduce((s, b) => s + Number(b.qty_on_hand), 0);
const tb = async () => Object.fromEntries((await owner.get(`/api/finance/${seed.units.FNB}/trial-balance`)).body.map((a) => [a.code, Number(a.balance)]));

test('managers write recipes; cashiers cannot; cost and margin are shown to finance readers only', async () => {
  const body = { yieldQty: 1, lines: [{ itemId: fanta.id, qty: 0.5 }, { itemId: sprite.id, qty: 0.5 }, { itemId: grenadine.id, qty: 30 }] };
  assert.equal((await cashier.api.put(`${R()}/${chapman.id}`, body)).status, 403);
  assert.equal((await manager.api.put(`${R()}/${chapman.id}`, body)).status, 200);
  const list = (await manager.api.get(R())).body;
  const c = list.find((r) => r.output_item_id === chapman.id);
  assert.equal(Number(c.unit_cost), 550, '½ × 400 + ½ × 400 + 30 × 5');
  assert.equal(c.margin_pct, 84.3);
  const asCook = (await cook.api.get(R())).body.find((r) => r.output_item_id === chapman.id);
  assert.equal(Number(asCook.unit_cost), 550, 'storekeepers have finance read');
  assert.equal((await manager.api.put(`${R()}/${chapman.id}`, { lines: [{ itemId: chapman.id, qty: 1 }] })).status, 400, 'no self-reference');
});

let ticket;
test('selling a recipe item deducts its ingredients from the till store at cost', async () => {
  const res = await cashier.api.post(`/api/pos/${seed.units.FNB}/checkout`, {
    departmentId: bar.id, locationId: barStore.id, lines: [{ itemId: chapman.id, qty: 2 }],
    payments: [{ method: 'cash', amount: 10000 }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  ticket = res.body.id;
  assert.equal(await qtyAt(fanta, barStore), 9);
  assert.equal(await qtyAt(sprite, barStore), 9);
  assert.equal(await qtyAt(grenadine, barStore), 940);
  const t = (await manager.api.get(`/api/pos/${seed.units.FNB}/tickets/${ticket}`)).body;
  assert.equal(Number(t.lines[0].cost_amount), 1100);
  assert.equal((await tb())['5000'], 1100);
});

test('a recipe item cannot be sold when an ingredient runs out', async () => {
  const res = await cashier.api.post(`/api/pos/${seed.units.FNB}/checkout`, {
    departmentId: bar.id, locationId: barStore.id, lines: [{ itemId: chapman.id, qty: 40 }],
    payments: [{ method: 'cash', amount: 1e6 }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not enough stock of (Fanta|Sprite|Grenadine)/);
  assert.equal(await qtyAt(fanta, barStore), 9, 'nothing deducted');
});

test('voiding a recipe sale puts every ingredient back', async () => {
  assert.equal((await owner.post(`/api/pos/${seed.units.FNB}/tickets/${ticket}/void`, { reason: 'Test void' })).status, 204);
  assert.equal(await qtyAt(fanta, barStore), 10);
  assert.equal(await qtyAt(grenadine, barStore), 1000);
  assert.equal((await tb())['5000'], 0);
});

let jollofRecipe;
test('production: plan 20 portions, produce 18 using a little more rice; yield variance and cost per portion', async () => {
  await manager.api.put(`${R()}/${jollof.id}`, { yieldQty: 10, lines: [{ itemId: rice.id, qty: 1 }, { itemId: oil.id, qty: 0.2 }] });
  jollofRecipe = (await manager.api.get(R())).body.find((r) => r.output_item_id === jollof.id).id;
  const created = await cook.api.post(PR(), { recipeId: jollofRecipe, plannedQty: 20, fromLocationId: kitchenStore.id, toLocationId: pass.id });
  assert.equal(created.status, 201);
  let order = (await cook.api.get(PR())).body.find((o) => o.id === created.body.id);
  assert.match(order.order_number, /^PRD-FNB-/);
  const riceLine = order.lines.find((l) => l.item_id === rice.id);
  assert.equal(Number(riceLine.planned_qty), 2);
  assert.equal(Number(order.lines.find((l) => l.item_id === oil.id).planned_qty), 0.4);

  assert.equal((await cook.api.post(`${PR()}/${created.body.id}/complete`, {
    actualOutput: 18, lines: [{ lineId: riceLine.id, actualQty: 2.1 }] })).status, 204);
  order = (await cook.api.get(PR())).body.find((o) => o.id === created.body.id);
  assert.equal(order.status, 'completed');
  assert.equal(Number(order.yield_variance_pct), -10);
  // 2.1 kg × 1500 + 0.4 l × 2000 = 3150 + 800 = 3950 → 219.4444 per portion
  assert.equal(Number(order.input_cost), 3950);
  assert.equal(Number(order.output_unit_cost), 219.4444);
  assert.equal(await qtyAt(jollof, pass), 18);
  assert.equal(await qtyAt(rice, kitchenStore), 7.9);
  const b = await tb();
  assert.equal(b['1250'], 0, 'production-in-progress clears');
  assert.equal(Object.values(b).reduce((s, v) => s + v, 0), 0);
});

test('a failed batch writes the ingredients off', async () => {
  const created = await cook.api.post(PR(), { recipeId: jollofRecipe, plannedQty: 10, fromLocationId: kitchenStore.id, toLocationId: pass.id });
  const before = (await tb())['5100'];
  assert.equal((await cook.api.post(`${PR()}/${created.body.id}/complete`, { actualOutput: 0 })).status, 204);
  const b = await tb();
  assert.equal(b['5100'] - before, 1500 + 400, 'all ingredient cost written off');
  assert.equal(b['1250'], 0);
});

test('made-to-order items are not produced; planned orders can be cancelled once', async () => {
  await manager.api.put(`${R()}/${chapman.id}`, { yieldQty: 1, lines: [{ itemId: fanta.id, qty: 1 }] });
  const chapRecipe = (await manager.api.get(R())).body.find((r) => r.output_item_id === chapman.id).id;
  const res = await cook.api.post(PR(), { recipeId: chapRecipe, plannedQty: 5, fromLocationId: barStore.id, toLocationId: pass.id });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /made to order/);

  const o = await cook.api.post(PR(), { recipeId: jollofRecipe, plannedQty: 10, fromLocationId: kitchenStore.id, toLocationId: pass.id });
  assert.equal((await cook.api.post(`${PR()}/${o.body.id}/cancel`)).status, 204);
  assert.equal((await cook.api.post(`${PR()}/${o.body.id}/complete`, { actualOutput: 10 })).status, 400);
});

test('sold jollof is costed at its production cost', async () => {
  const res = await owner.post(`/api/pos/${seed.units.FNB}/checkout`, {
    departmentId: bar.id, locationId: pass.id, lines: [{ itemId: jollof.id, qty: 2 }], payments: [{ method: 'card', amount: 9460 }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const t = (await owner.get(`/api/pos/${seed.units.FNB}/tickets/${res.body.id}`)).body;
  assert.equal(Number(t.lines[0].cost_amount), 438.89);
});

test('partnership walls on recipes', async () => {
  assert.deepEqual((await partner.get(R())).body, []);
  await partner.put(`/api/recipes/${seed.units.SPA}/${oilSpa.id}`, { lines: [{ itemId: oilSpa.id, qty: 1 }] });
  assert.equal((await owner.put(`/api/recipes/${seed.units.SPA}/${oilSpa.id}`, { lines: [{ itemId: oilSpa.id, qty: 1 }] })).status, 403);
  assert.equal((await partner.post(PR(), { recipeId: jollofRecipe, plannedQty: 1, fromLocationId: kitchenStore.id, toLocationId: pass.id })).status, 403);
});
