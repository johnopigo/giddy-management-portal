import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, ownerQuery, staffMember } from './helpers.js';

let seed, owner, partner, cashier, manager;
let water, corkage, unpriced, oil, barStore, kitchen, bar, spaStore, spaDept;
const P = () => `/api/pos/${seed.units.FNB}`;
const F = () => `/api/finance/${seed.units.FNB}`;

before(async () => {
  seed = await resetDatabase();
  [owner, partner] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local')]);
  const depts = (await owner.get('/api/org')).body.departments;
  bar = depts.find((d) => d.name === 'Bar');
  kitchen = depts.find((d) => d.name === 'Kitchen');
  spaDept = depts.find((d) => d.name === 'Spa Reception');
  cashier = await staffMember(owner, { email: 'cashier@test.local', role: 'CASHIER', businessUnitId: seed.units.FNB, departmentId: bar.id });
  manager = await staffMember(owner, { email: 'manager@test.local', role: 'UNIT_MANAGER', businessUnitId: seed.units.FNB });

  const each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  const litre = (await owner.post('/api/catalog/uoms', { code: 'l', name: 'Litre' })).body;
  water = (await owner.post('/api/catalog/items', { sku: 'WATER', name: 'Water', baseUomId: each.id, isSellable: true })).body;
  corkage = (await owner.post('/api/catalog/items', { sku: 'CORKAGE', name: 'Corkage', baseUomId: each.id, isSellable: true, isStockable: false })).body;
  unpriced = (await owner.post('/api/catalog/items', { sku: 'PALMWINE', name: 'Palm wine', baseUomId: litre.id, isSellable: true })).body;
  oil = (await partner.post('/api/catalog/items', { sku: 'OIL', name: 'Oil', baseUomId: each.id, ownerBusinessUnitId: seed.units.SPA, isSellable: true })).body;
  await owner.put(`/api/catalog/items/${water.id}/units/${seed.units.FNB}`, { sellPrice: 800 });
  await owner.put(`/api/catalog/items/${corkage.id}/units/${seed.units.FNB}`, { sellPrice: 2000 });
  await owner.put(`/api/catalog/items/${unpriced.id}/units/${seed.units.FNB}`, {});
  await partner.put(`/api/catalog/items/${oil.id}/units/${seed.units.SPA}`, { sellPrice: 5000 });

  const main = (await owner.post(`/api/inventory/${seed.units.FNB}/locations`, { tier: 'branch', name: 'Main', branchId: seed.branchId })).body;
  barStore = (await owner.post(`/api/inventory/${seed.units.FNB}/locations`, {
    tier: 'department', name: 'Bar', branchId: seed.branchId, departmentId: bar.id, parentLocationId: main.id })).body;
  await owner.post(`/api/inventory/${seed.units.FNB}/movements`, { type: 'opening_balance', itemId: water.id, qty: 20, toLocationId: barStore.id, unitCost: 450 });
  spaStore = (await partner.post(`/api/inventory/${seed.units.SPA}/locations`, { tier: 'branch', name: 'Spa Store', branchId: seed.branchId })).body;
  await partner.post(`/api/inventory/${seed.units.SPA}/movements`, { type: 'opening_balance', itemId: oil.id, qty: 5, toLocationId: spaStore.id, unitCost: 2500 });
});
after(closePools);

const sell = (api, body) => api.post(`${P()}/checkout`, { departmentId: bar.id, locationId: barStore.id, ...body });
const onHand = async () => (await owner.get(`/api/inventory/${seed.units.FNB}/balances?itemId=${water.id}&locationId=${barStore.id}`)).body
  .reduce((s, b) => s + Number(b.qty_on_hand), 0);
const tb = async (api = owner, base = F()) => Object.fromEntries((await api.get(`${base}/trial-balance`)).body.map((a) => [a.code, Number(a.balance)]));

let firstTicket;
test('a cashier rings up a multi-line ticket: service charge, VAT, change', async () => {
  const res = await sell(cashier.api, {
    lines: [{ itemId: water.id, qty: 2 }, { itemId: corkage.id, qty: 1 }],
    payments: [{ method: 'cash', amount: 5000 }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  firstTicket = res.body.id;
  const t = (await cashier.api.get(`${P()}/tickets/${firstTicket}`)).body;
  // 2 × 800 + 2000 = 3600; service 10% = 360; VAT 7.5% of 3960 = 297; total 4257
  assert.deepEqual([t.subtotal, t.service_charge_amount, t.tax_amount, t.total, t.change_due].map(Number), [3600, 360, 297, 4257, 743]);
  assert.match(t.ticket_number, /^TKT-FNB-000001$/);
  assert.equal(t.lines[1].cost_amount, null, 'cashiers do not see cost');
  assert.equal(await onHand(), 18, 'stock left the bar store; corkage is not stocked');
});

test('the sale posts balanced journal entries: takings, revenue, service, VAT, and cost of sales', async () => {
  const b = await tb();
  assert.equal(b['1000'], 4257, 'cash in the drawer, net of change');
  assert.equal(b['4000'], -3600);
  assert.equal(b['4100'], -360);
  assert.equal(b['2100'], -297);
  assert.equal(b['5000'], 900, 'cost of 2 waters at 450');
  assert.equal(b['1200'], 20 * 450 - 900);
  assert.equal(b['3000'], -9000, 'opening stock against opening equity');
  assert.equal(Object.values(b).reduce((s, v) => s + v, 0), 0, 'trial balance sums to zero');
});

test('a Bar cashier cannot sell in the Kitchen; managers without finance write cannot sell at all', async () => {
  const k = await sell(cashier.api, { departmentId: kitchen.id, lines: [{ itemId: corkage.id, qty: 1 }], payments: [{ method: 'cash', amount: 3000 }] });
  assert.equal(k.status, 403);
  const m = await sell(manager.api, { lines: [{ itemId: corkage.id, qty: 1 }], payments: [{ method: 'cash', amount: 3000 }] });
  assert.equal(m.status, 403);
  const cat = (await cashier.api.get(`${P()}/catalog?locationId=${barStore.id}`)).body;
  assert.deepEqual(cat.departments.map((d) => d.name), ['Bar'], 'the till offers only the departments you can sell in');
  assert.equal(Number(cat.items.find((i) => i.id === water.id).on_hand), 18);
  assert.ok(!cat.items.some((i) => i.id === unpriced.id), 'items without a price are not on the till');
});

test('payments: short, card over the total, and split payments', async () => {
  const before = await onHand();
  const short = await sell(cashier.api, { lines: [{ itemId: water.id, qty: 1 }], payments: [{ method: 'cash', amount: 100 }] });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /short of the total/);
  assert.equal(await onHand(), before, 'a refused sale leaves stock untouched');

  const overCard = await sell(cashier.api, { lines: [{ itemId: water.id, qty: 1 }], payments: [{ method: 'card', amount: 5000 }] });
  assert.equal(overCard.status, 400);
  assert.match(overCard.body.error, /change is only given from cash/);

  // 1 water: 800 + 80 + 66 = 946. Card 500 + cash 1000 → change 554.
  const split = await sell(cashier.api, { lines: [{ itemId: water.id, qty: 1 }],
    payments: [{ method: 'card', amount: 500, reference: 'POS-1182' }, { method: 'cash', amount: 1000 }] });
  assert.equal(split.status, 201);
  const t = (await cashier.api.get(`${P()}/tickets/${split.body.id}`)).body;
  assert.equal(Number(t.change_due), 554);
});

test('fractional quantities, unpriced items and insufficient stock', async () => {
  assert.equal((await sell(cashier.api, { lines: [{ itemId: water.id, qty: 0.5 }], payments: [{ method: 'cash', amount: 1000 }] })).status, 201);
  const unp = await sell(cashier.api, { lines: [{ itemId: unpriced.id, qty: 1 }], payments: [{ method: 'cash', amount: 1000 }] });
  assert.equal(unp.status, 400);
  const tooMany = await sell(cashier.api, { lines: [{ itemId: water.id, qty: 500 }], payments: [{ method: 'cash', amount: 1e7 }] });
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error, /not enough stock/);
});

test('discounts above the limit need a manager-level seller', async () => {
  const big = await sell(cashier.api, { discountPct: 15, lines: [{ itemId: corkage.id, qty: 1 }], payments: [{ method: 'cash', amount: 3000 }] });
  assert.equal(big.status, 403);
  assert.match(big.body.error, /above 10% need a manager/);
  const ok = await sell(cashier.api, { discountPct: 10, lines: [{ itemId: corkage.id, qty: 1 }], payments: [{ method: 'cash', amount: 3000 }] });
  assert.equal(ok.status, 201);
  const ownerBig = await sell(owner, { discountPct: 50, lines: [{ itemId: corkage.id, qty: 1 }], payments: [{ method: 'cash', amount: 3000 }] });
  assert.equal(ownerBig.status, 201);
  const t = (await owner.get(`${P()}/tickets/${ownerBig.body.id}`)).body;
  // 2000 − 50% = 1000; +100 service; +82.50 VAT
  assert.deepEqual([t.discount_amount, t.total].map(Number), [1000, 1182.5]);
});

test('voids: owner only, with a reason; stock and books are restored', async () => {
  assert.equal((await cashier.api.post(`${P()}/tickets/${firstTicket}/void`, { reason: 'Wrong table' })).status, 403);
  assert.equal((await manager.api.post(`${P()}/tickets/${firstTicket}/void`, { reason: 'Wrong table' })).status, 403);
  assert.equal((await owner.post(`${P()}/tickets/${firstTicket}/void`, { reason: '' })).status, 400);

  const before = await onHand();
  const tbBefore = await tb();
  assert.equal((await owner.post(`${P()}/tickets/${firstTicket}/void`, { reason: 'Rung up on the wrong table' })).status, 204);
  assert.equal(await onHand(), before + 2);
  const after = await tb();
  assert.equal(after['1000'], tbBefore['1000'] - 4257, 'cash refunded');
  assert.equal(after['4000'], tbBefore['4000'] + 3600, 'revenue reversed');
  assert.equal(after['5000'], tbBefore['5000'] - 900, 'cost of sales reversed');
  assert.equal(Object.values(after).reduce((s, v) => s + v, 0), 0);

  const t = (await owner.get(`${P()}/tickets/${firstTicket}`)).body;
  assert.equal(t.status, 'voided');
  assert.equal(t.voided_by_name, 'Owner');
  assert.equal((await owner.post(`${P()}/tickets/${firstTicket}/void`, { reason: 'again' })).status, 400);
});

test('sales history: cashiers see their own, managers see everything', async () => {
  const mine = (await cashier.api.get(`${P()}/tickets`)).body;
  assert.ok(mine.length > 0 && mine.every((t) => t.seller_name === 'cashier'));
  const all = (await manager.api.get(`${P()}/tickets`)).body;
  assert.ok(all.some((t) => t.seller_name === 'Owner'));
  const summary = (await manager.api.get(`${P()}/summary`)).body;
  assert.equal(summary.voids, 1);
  assert.ok(summary.byMethod.some((m) => m.method === 'card' && m.amount === 500));
});

test('partnership walls at the till', async () => {
  assert.equal((await partner.post(`${P()}/checkout`, { departmentId: bar.id, locationId: barStore.id,
    lines: [{ itemId: corkage.id, qty: 1 }], payments: [{ method: 'cash', amount: 3000 }] })).status, 403);
  const spaSale = await partner.post(`/api/pos/${seed.units.SPA}/checkout`, { departmentId: spaDept.id, locationId: spaStore.id,
    lines: [{ itemId: oil.id, qty: 1 }], payments: [{ method: 'transfer', amount: 5912.5 }] });
  assert.equal(spaSale.status, 201, JSON.stringify(spaSale.body));
  assert.equal((await owner.post(`/api/pos/${seed.units.SPA}/checkout`, { departmentId: spaDept.id, locationId: spaStore.id,
    lines: [{ itemId: oil.id, qty: 1 }], payments: [{ method: 'cash', amount: 6000 }] })).status, 403, 'owner cannot sell in the Spa');
  const ownerView = (await owner.get(`/api/pos/${seed.units.SPA}/tickets`)).body;
  assert.equal(ownerView.length, 1, 'but can read Spa sales');
  assert.equal((await owner.post(`/api/pos/${seed.units.SPA}/tickets/${spaSale.body.id}/void`, { reason: 'x y z' })).status, 403);
  assert.deepEqual((await partner.get(`${F()}/trial-balance`)).body, [], 'partner cannot read F&B books');
  const spaTb = await tb(owner, `/api/finance/${seed.units.SPA}`);
  assert.equal(spaTb['1020'], 5912.5, 'owner reads Spa books');
});

test('inter-unit transfers create matching due-from / due-to balances', async () => {
  await partner.put(`/api/catalog/items/${water.id}/units/${seed.units.SPA}`, {});
  const t = await owner.post('/api/transfers', { fromBusinessUnitId: seed.units.FNB, toBusinessUnitId: seed.units.SPA,
    fromLocationId: barStore.id, lines: [{ itemId: water.id, qty: 4 }] });
  await partner.post(`/api/transfers/${t.body.id}/receive`, { toLocationId: spaStore.id });
  const fnb = (await owner.get(`${F()}/journal?accountCode=1150&limit=1`)).body[0];
  const due = fnb.lines.find((l) => l.code === '1150');
  assert.equal(Number(due.debit), 1800);
  assert.equal(due.counterparty, 'Spa');
  const spa = (await partner.get(`/api/finance/${seed.units.SPA}/journal?accountCode=2200&limit=1`)).body[0];
  assert.equal(Number(spa.lines.find((l) => l.code === '2200').credit), 1800);
});

test('the ledger cannot be edited, and an unbalanced entry is impossible', async () => {
  await assert.rejects(ownerQuery('UPDATE journal_line SET debit = debit + 1'), /append-only/);
  await assert.rejects(ownerQuery(`
    WITH e AS (
      INSERT INTO journal_entry (tenant_id, business_unit_id, period_id, entry_date, source_doc_type)
      SELECT tenant_id, business_unit_id, id, current_date, 'test' FROM fiscal_period WHERE business_unit_id = $1 LIMIT 1
      RETURNING id, tenant_id, business_unit_id)
    INSERT INTO journal_line (tenant_id, business_unit_id, journal_entry_id, account_id, debit)
    SELECT e.tenant_id, e.business_unit_id, e.id, a.id, 100 FROM e JOIN ledger_account a ON a.business_unit_id = e.business_unit_id AND a.code = '1000'`,
  [seed.units.FNB]), /does not balance/);
});

test('periods: only ended periods close, only by the owner of the books, and then refuse postings', async () => {
  const current = (await owner.get(`${F()}/periods`)).body[0];
  assert.equal((await owner.post(`${F()}/periods/${current.id}/close`)).status, 400, 'still running');
  const { rows } = await ownerQuery(`INSERT INTO fiscal_period (tenant_id, business_unit_id, period_start, period_end)
    VALUES ($1, $2, date_trunc('month', current_date - interval '1 month'), date_trunc('month', current_date) - interval '1 day')
    RETURNING id`, [seed.tenantId, seed.units.FNB]);
  assert.equal((await manager.api.post(`${F()}/periods/${rows[0].id}/close`)).status, 403);
  assert.equal((await owner.post(`${F()}/periods/${rows[0].id}/close`)).status, 204);
  await assert.rejects(ownerQuery(`SELECT fin.post_entry($1, (current_date - interval '1 month')::date, 'test', NULL, 'late',
    '[{"code":"1000","debit":1},{"code":"4000","credit":1}]')`, [seed.units.FNB]), /is closed/);
});

test('sale records are permanent and the audit chain is intact', async () => {
  await assert.rejects(ownerQuery('UPDATE sale_line SET unit_price = 1'), /append-only/);
  await assert.rejects(ownerQuery(`UPDATE sale_ticket SET total = 1 WHERE id = $1`, [firstTicket]), /only be voided/);
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
