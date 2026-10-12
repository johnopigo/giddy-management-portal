import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, ownerQuery, staffMember } from './helpers.js';

let seed, owner, partner, keeper, manager, staff;
let each, water, wine, oil, supplier;
let fnbMain, barStore, spaStore;
const FNB = () => `/api/procurement/${seed.units.FNB}`;
const SPA = () => `/api/procurement/${seed.units.SPA}`;
const day = (o) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  seed = await resetDatabase();
  [owner, partner] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local')]);
  keeper = await staffMember(owner, { email: 'keeper@test.local', role: 'STOREKEEPER', businessUnitId: seed.units.FNB });
  manager = await staffMember(owner, { email: 'manager@test.local', role: 'UNIT_MANAGER', businessUnitId: seed.units.FNB });
  staff = await staffMember(owner, { email: 'waiter@test.local', role: 'STAFF', businessUnitId: seed.units.FNB });

  each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  water = (await owner.post('/api/catalog/items', { sku: 'WATER', name: 'Water', baseUomId: each.id })).body;
  wine = (await owner.post('/api/catalog/items', { sku: 'WINE', name: 'Wine', baseUomId: each.id })).body;
  oil = (await partner.post('/api/catalog/items', { sku: 'OIL', name: 'Oil', baseUomId: each.id, ownerBusinessUnitId: seed.units.SPA, isExpiryTracked: true })).body;
  await owner.put(`/api/catalog/items/${water.id}/units/${seed.units.FNB}`, { reorderLevel: 20, reorderQty: 48 });
  await owner.put(`/api/catalog/items/${wine.id}/units/${seed.units.FNB}`, {});
  await partner.put(`/api/catalog/items/${oil.id}/units/${seed.units.SPA}`, {});
  supplier = (await owner.post('/api/suppliers', { name: 'Lagos Beverages' })).body;

  const bar = (await owner.get('/api/org')).body.departments.find((d) => d.name === 'Bar');
  fnbMain = (await owner.post(`/api/inventory/${seed.units.FNB}/locations`, { tier: 'branch', name: 'Main', branchId: seed.branchId })).body;
  barStore = (await owner.post(`/api/inventory/${seed.units.FNB}/locations`, {
    tier: 'department', name: 'Bar', branchId: seed.branchId, departmentId: bar.id, parentLocationId: fnbMain.id })).body;
  spaStore = (await partner.post(`/api/inventory/${seed.units.SPA}/locations`, { tier: 'branch', name: 'Spa Store', branchId: seed.branchId })).body;
});
after(closePools);

const draft = (api, base, lines, extra = {}) => api.post(`${base}/purchase-orders`, { supplierId: supplier.id, lines, ...extra });
const po = async (api, base, id) => (await api.get(`${base}/purchase-orders/${id}`)).body;
const onHand = async (bu, itemId, locationId) => (await owner.get(`/api/inventory/${bu}/balances?itemId=${itemId}${locationId ? `&locationId=${locationId}` : ''}`)).body
  .reduce((s, b) => s + Number(b.qty_on_hand), 0);

let mainPo;
test('storekeeper drafts and submits; the manager is notified', async () => {
  const created = await draft(keeper.api, FNB(), [{ itemId: water.id, qty: 24, unitCost: 400 }]);
  assert.equal(created.status, 201);
  mainPo = created.body.id;
  const edited = await keeper.api.put(`${FNB()}/purchase-orders/${mainPo}`, {
    supplierId: supplier.id, lines: [{ itemId: water.id, qty: 24, unitCost: 400 }, { itemId: wine.id, qty: 6, unitCost: 7000 }] });
  assert.equal(edited.status, 200);
  const p = await po(keeper.api, FNB(), mainPo);
  assert.match(p.po_number, /^PO-FNB-000001$/);
  assert.equal(p.total, 24 * 400 + 6 * 7000);

  assert.equal((await keeper.api.post(`${FNB()}/purchase-orders/${mainPo}/submit`)).status, 204);
  const inbox = (await manager.api.get('/api/notifications')).body;
  assert.ok(inbox.items.some((n) => n.kind === 'po_submitted' && n.title.includes('PO-FNB-000001')));
  assert.equal((await keeper.api.put(`${FNB()}/purchase-orders/${mainPo}`, { supplierId: supplier.id, lines: [{ itemId: water.id, qty: 1, unitCost: 1 }] })).status, 400,
    'submitted orders cannot be edited');
});

test('only a manager approves, and goods cannot be received before approval', async () => {
  const rx = { locationId: fnbMain.id, lines: [] };
  const lines = (await po(keeper.api, FNB(), mainPo)).lines;
  rx.lines = [{ poLineId: lines[0].id, qty: 10 }];
  assert.equal((await keeper.api.post(`${FNB()}/purchase-orders/${mainPo}/receive`, rx)).status, 400);
  assert.equal((await keeper.api.post(`${FNB()}/purchase-orders/${mainPo}/approve`)).status, 403);
  assert.equal((await manager.api.post(`${FNB()}/purchase-orders/${mainPo}/approve`)).status, 204);
  assert.ok((await keeper.api.get('/api/notifications')).body.items.some((n) => n.kind === 'po_approved'));
});

test('partial receipt, over-receipt refused, then full receipt; average cost follows', async () => {
  const lines = (await po(keeper.api, FNB(), mainPo)).lines;
  const waterLine = lines.find((l) => l.item_id === water.id);
  const wineLine = lines.find((l) => l.item_id === wine.id);

  const first = await keeper.api.post(`${FNB()}/purchase-orders/${mainPo}/receive`, {
    locationId: fnbMain.id, supplierInvoiceRef: 'INV-77', lines: [{ poLineId: waterLine.id, qty: 10 }] });
  assert.equal(first.status, 201);
  assert.equal((await po(keeper.api, FNB(), mainPo)).status, 'partially_received');
  assert.equal(await onHand(seed.units.FNB, water.id), 10);

  const over = await keeper.api.post(`${FNB()}/purchase-orders/${mainPo}/receive`, {
    locationId: fnbMain.id, lines: [{ poLineId: waterLine.id, qty: 15 }] });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /only 14 outstanding/);

  assert.equal((await keeper.api.post(`${FNB()}/purchase-orders/${mainPo}/receive`, {
    locationId: fnbMain.id, lines: [{ poLineId: waterLine.id, qty: 14 }, { poLineId: wineLine.id, qty: 6 }] })).status, 201);
  const done = await po(keeper.api, FNB(), mainPo);
  assert.equal(done.status, 'received');
  assert.equal(done.receipts.length, 2);
  assert.match(done.receipts[0].receipt_number, /^GRN-FNB-/);
});

test('moving average: new receipts at a different price re-average; issues are valued at the average', async () => {
  const second = await draft(owner, FNB(), [{ itemId: water.id, qty: 24, unitCost: 600 }]);
  await owner.post(`${FNB()}/purchase-orders/${second.body.id}/submit`);
  assert.equal((await owner.post(`${FNB()}/purchase-orders/${second.body.id}/approve`)).status, 204,
    'the owner may approve their own order (they hold finance write)');
  const line = (await po(owner, FNB(), second.body.id)).lines[0];
  await owner.post(`${FNB()}/purchase-orders/${second.body.id}/receive`, { locationId: fnbMain.id, lines: [{ poLineId: line.id, qty: 24 }] });

  const valuation = (await owner.get(`/api/inventory/${seed.units.FNB}/valuation`)).body;
  const w = valuation.find((v) => v.item_id === water.id);
  assert.equal(Number(w.avg_unit_cost), 500, '24 @ 400 + 24 @ 600 = 48 @ 500');
  assert.equal(Number(w.stock_value), 48 * 500);

  await owner.post(`/api/inventory/${seed.units.FNB}/movements`, { type: 'issue', itemId: water.id, qty: 2, fromLocationId: fnbMain.id });
  const issued = (await owner.get(`/api/inventory/${seed.units.FNB}/movements?itemId=${water.id}&limit=1`)).body[0];
  assert.equal(Number(issued.unit_cost), 500);
  assert.deepEqual((await staff.api.get(`/api/inventory/${seed.units.FNB}/valuation`)).body, [], 'no finance access, no valuation');
});

test('segregation: a manager cannot approve an order they submitted', async () => {
  const own = await draft(manager.api, FNB(), [{ itemId: wine.id, qty: 1, unitCost: 7000 }]);
  await manager.api.post(`${FNB()}/purchase-orders/${own.body.id}/submit`);
  const res = await manager.api.post(`${FNB()}/purchase-orders/${own.body.id}/approve`);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /you submitted/);
});

test('sending back needs a reason and returns the order to draft', async () => {
  const p = await draft(keeper.api, FNB(), [{ itemId: wine.id, qty: 2, unitCost: 7000 }]);
  await keeper.api.post(`${FNB()}/purchase-orders/${p.body.id}/submit`);
  assert.equal((await manager.api.post(`${FNB()}/purchase-orders/${p.body.id}/reject`)).status, 400);
  assert.equal((await manager.api.post(`${FNB()}/purchase-orders/${p.body.id}/reject`, { note: 'Use the cheaper supplier' })).status, 204);
  const back = await po(keeper.api, FNB(), p.body.id);
  assert.equal(back.status, 'draft');
  assert.equal(back.rejection_note, 'Use the cheaper supplier');
});

test('closing short and cancelling', async () => {
  const p = await draft(owner, FNB(), [{ itemId: wine.id, qty: 10, unitCost: 7000 }]);
  await owner.post(`${FNB()}/purchase-orders/${p.body.id}/submit`);
  await owner.post(`${FNB()}/purchase-orders/${p.body.id}/approve`);
  const line = (await po(owner, FNB(), p.body.id)).lines[0];
  await owner.post(`${FNB()}/purchase-orders/${p.body.id}/receive`, { locationId: fnbMain.id, lines: [{ poLineId: line.id, qty: 4 }] });
  assert.equal((await owner.post(`${FNB()}/purchase-orders/${p.body.id}/cancel`)).status, 400, 'cannot cancel after receiving');
  assert.equal((await owner.post(`${FNB()}/purchase-orders/${p.body.id}/close`, { note: 'Supplier out of stock' })).status, 204);
  assert.equal((await po(owner, FNB(), p.body.id)).status, 'closed');

  const c = await draft(keeper.api, FNB(), [{ itemId: wine.id, qty: 1, unitCost: 1 }]);
  assert.equal((await keeper.api.post(`${FNB()}/purchase-orders/${c.body.id}/cancel`)).status, 204, 'creator cancels own draft');
});

test('batch-tracked receipts need batch and expiry (Spa)', async () => {
  const p = await draft(partner, SPA(), [{ itemId: oil.id, qty: 5, unitCost: 3000 }]);
  await partner.post(`${SPA()}/purchase-orders/${p.body.id}/submit`);
  await partner.post(`${SPA()}/purchase-orders/${p.body.id}/approve`);
  const line = (await po(partner, SPA(), p.body.id)).lines[0];
  assert.equal((await partner.post(`${SPA()}/purchase-orders/${p.body.id}/receive`, {
    locationId: spaStore.id, lines: [{ poLineId: line.id, qty: 5 }] })).status, 400);
  assert.equal((await partner.post(`${SPA()}/purchase-orders/${p.body.id}/receive`, {
    locationId: spaStore.id, lines: [{ poLineId: line.id, qty: 5, batchNo: 'L1', expiryDate: day(200) }] })).status, 201);
});

test('partnership walls on purchasing', async () => {
  assert.deepEqual((await partner.get(`${FNB()}/purchase-orders`)).body, [], 'partner cannot see F&B orders');
  assert.equal((await partner.get(`${FNB()}/purchase-orders/${mainPo}`)).status, 404);
  const spaOrders = (await owner.get(`${SPA()}/purchase-orders`)).body;
  assert.equal(spaOrders.length, 1, 'owner can read Spa orders');
  const p = await draft(partner, SPA(), [{ itemId: oil.id, qty: 1, unitCost: 3000 }]);
  await partner.post(`${SPA()}/purchase-orders/${p.body.id}/submit`);
  assert.equal((await owner.post(`${SPA()}/purchase-orders/${p.body.id}/approve`)).status, 403, 'owner cannot approve Spa orders');
  assert.equal((await draft(owner, SPA(), [{ itemId: oil.id, qty: 1, unitCost: 1 }])).status, 403);
});

test('receipts are permanent and cannot be posted by hand', async () => {
  await assert.rejects(ownerQuery('UPDATE goods_receipt SET notes = $1', ['x']), /append-only/);
  const manual = await owner.post(`/api/inventory/${seed.units.FNB}/movements`, {
    type: 'receipt', itemId: water.id, qty: 1, toLocationId: fnbMain.id, unitCost: 1 });
  assert.equal(manual.status, 400);
});

test('reorder suggestions list items at or below their reorder level with the last price', async () => {
  await owner.post(`/api/inventory/${seed.units.FNB}/movements`, { type: 'issue', itemId: water.id, qty: 30, fromLocationId: fnbMain.id });
  const suggestions = (await keeper.api.get(`${FNB()}/reorder-suggestions`)).body;
  const w = suggestions.find((s) => s.item_id === water.id);
  assert.equal(Number(w.on_hand), 16);
  assert.equal(Number(w.suggested_qty), 48);
  assert.equal(Number(w.last_unit_cost), 600);
  assert.equal(w.last_supplier_name, 'Lagos Beverages');
  assert.ok((await manager.api.get('/api/notifications')).body.items.some((n) => n.kind === 'low_stock'),
    'the manager got a low-stock alert');
});

test('item requests: staff ask, manager approves, storekeeper fulfils', async () => {
  const R = `/api/requests/${seed.units.FNB}`;
  const created = await staff.api.post(R, { fromLocationId: fnbMain.id, toLocationId: barStore.id, lines: [{ itemId: water.id, qty: 3 }] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await staff.api.post(`${R}/${id}/approve`)).status, 403, 'staff cannot approve');
  assert.equal((await keeper.api.post(`${R}/${id}/fulfil`)).status, 400, 'not approved yet');

  const list = (await manager.api.get(R)).body;
  const req = list.find((r) => r.id === id);
  assert.equal(req.status, 'pending');
  assert.equal((await manager.api.post(`${R}/${id}/approve`, { lines: [{ lineId: req.lines[0].id, qtyApproved: 2 }] })).status, 204);

  const before = await onHand(seed.units.FNB, water.id, barStore.id);
  assert.equal((await staff.api.post(`${R}/${id}/fulfil`)).status, 403, 'staff cannot issue stock');
  assert.equal((await keeper.api.post(`${R}/${id}/fulfil`)).status, 204);
  assert.equal(await onHand(seed.units.FNB, water.id, barStore.id), before + 2, 'approved quantity, not requested');
  assert.ok((await staff.api.get('/api/notifications')).body.items.some((n) => n.kind === 'request_fulfilled'));
  assert.equal((await staff.api.post(`${R}/${id}/cancel`)).status, 400);
});

test('notifications can be marked read', async () => {
  const inbox = (await manager.api.get('/api/notifications')).body;
  assert.ok(inbox.unread > 0);
  await manager.api.post('/api/notifications/read-all');
  assert.equal((await manager.api.get('/api/notifications')).body.unread, 0);
});

test('audit chain is intact after all of this', async () => {
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
