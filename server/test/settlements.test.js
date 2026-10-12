// Partnership settlements: terms agreed between the Owner and the Spa partner (any of them may be left
// blank until known), monthly statements computed from the Spa's books, agreed, accrued and paid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, ownerQuery } from './helpers.js';

let seed, owner, partner, it;
const P = () => `/api/partnership/${seed.units.SPA}`;
const B = () => `/api/bookings/${seed.units.SPA}`;
const ym = (d) => d.toISOString().slice(0, 7);
const now = new Date();
const THIS_MONTH = ym(now);
const LAST_MONTH = ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)));
const allDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opens: '00:00', closes: '24:00' }));
const tb = async () => Object.fromEntries((await partner.get(`/api/finance/${seed.units.SPA}/trial-balance`)).body
  .map((a) => [a.code, Number(a.balance)]));
const propose = (api, terms) => api.post(`${P()}/agreements`, { effectiveFrom: `${LAST_MONTH}-01`, ...terms });
const openProposal = async () => (await owner.get(`${P()}/agreements`)).body.agreements.find((g) => g.status === 'proposed');
const preview = async (month = LAST_MONTH) => (await owner.get(`${P()}/preview?month=${month}`)).body;

before(async () => {
  seed = await resetDatabase();
  [owner, partner, it] = await Promise.all([signIn('owner@test.local'), signIn('partner@test.local'), signIn('it@test.local')]);
  const SPA = seed.units.SPA;

  // A treatment with a product add-on, through the booking engine.
  const res = async (kind, name) => (await partner.post(`${B()}/resources`, { kind, name, hours: allDay })).body;
  const therapist = await res('staff', 'Ada');
  const room = await res('room', 'Room 1');
  const svc = (await partner.post(`${B()}/services`, { code: 'MAS', name: 'Massage', mode: 'service', durationMin: 60, price: 40000,
    resources: [{ resourceId: therapist.id, role: 'therapist' }, { resourceId: room.id, role: 'room' }] })).body;
  const each = (await owner.post('/api/catalog/uoms', { code: 'each', name: 'Each' })).body;
  const oil = (await partner.post('/api/catalog/items', { sku: 'OIL', name: 'Body oil', baseUomId: each.id, isSellable: true, ownerBusinessUnitId: SPA })).body;
  const nails = (await partner.post('/api/catalog/items', { sku: 'NAIL', name: 'Express nails', baseUomId: each.id, isSellable: true, isStockable: false, ownerBusinessUnitId: SPA })).body;
  await partner.put(`/api/catalog/items/${oil.id}/units/${SPA}`, { sellPrice: 10000 });
  await partner.put(`/api/catalog/items/${nails.id}/units/${SPA}`, { sellPrice: 3000 });
  const store = (await partner.post(`/api/inventory/${SPA}/locations`, { tier: 'branch', name: 'Spa store', branchId: seed.branchId })).body;
  await partner.post(`/api/inventory/${SPA}/movements`, { type: 'opening_balance', itemId: oil.id, qty: 10, toLocationId: store.id, unitCost: 4000 });
  const guest = (await partner.post('/api/customers', { fullName: 'Ngozi Obi', phone: '08037770000' })).body;
  const d = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
  const appt = (await partner.post(`${B()}/appointments`, { serviceId: svc.id, customerId: guest.id, startsAt: `${d}T10:00:00+01:00` })).body.id;
  await ownerQuery(
    `WITH a AS (UPDATE appointment SET starts_at = date_trunc('minute', now()) - interval '30 minutes', ends_at = date_trunc('minute', now()) + interval '30 minutes'
                 WHERE id = $1 RETURNING starts_at, ends_at)
     UPDATE appointment_resource SET during = tstzrange((SELECT starts_at FROM a), (SELECT ends_at FROM a)) WHERE appointment_id = $1`, [appt]);
  assert.equal((await partner.post(`${B()}/appointments/${appt}/check-in`)).status, 204);
  assert.equal((await partner.post(`${B()}/appointments/${appt}/addons`, { itemId: oil.id, qty: 1, locationId: store.id })).status, 201);
  assert.equal((await partner.post(`${B()}/appointments/${appt}/complete`)).status, 204);

  // A till sale: one product and one service.
  const dept = (await owner.get('/api/org')).body.departments.find((x) => x.business_unit_id === SPA);
  const sale = await partner.post(`/api/pos/${SPA}/checkout`, {
    departmentId: dept.id, locationId: store.id, lines: [{ itemId: oil.id, qty: 0.5 }, { itemId: nails.id, qty: 1 }],
    payments: [{ method: 'cash', amount: 8800 + 660 }],
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  // All of that happened last month.
  await ownerQuery(`ALTER TABLE journal_entry DISABLE TRIGGER journal_entry_immutable;
    UPDATE journal_entry SET entry_date = (entry_date - interval '1 month')::date WHERE business_unit_id = '${SPA}';
    ALTER TABLE journal_entry ENABLE TRIGGER journal_entry_immutable;
    UPDATE appointment SET completed_at = completed_at - interval '1 month' WHERE business_unit_id = '${SPA}';`);
});
after(closePools);

test('who speaks for each side; others see nothing', async () => {
  assert.deepEqual((await owner.get('/api/partnership/units')).body.map((u) => [u.code, u.my_side]), [['SPA', 'owner']]);
  assert.deepEqual((await partner.get('/api/partnership/units')).body.map((u) => [u.code, u.my_side]), [['SPA', 'partner']]);
  assert.deepEqual((await it.get('/api/partnership/units')).body, []);
  assert.equal((await propose(it, { ratePct: 10 })).status, 403);
  assert.equal((await owner.post(`/api/partnership/${seed.units.FNB}/agreements`, { effectiveFrom: `${LAST_MONTH}-01` })).status, 400);
});

test('terms may be agreed with blanks; a statement then names what is missing', async () => {
  assert.equal((await propose(partner, { notes: 'Rate to be confirmed by the lawyers' })).status, 201);
  assert.equal((await propose(owner, { ratePct: 10 })).status, 409, 'one open proposal at a time');
  const g = await openProposal();
  assert.equal((await partner.post(`${P()}/agreements/${g.id}/decide`, { accept: true })).status, 403, 'not your own proposal');
  assert.equal((await owner.post(`${P()}/agreements/${g.id}/decide`, { accept: false })).status, 400, 'a rejection needs a reason');
  assert.equal((await owner.post(`${P()}/agreements/${g.id}/decide`, { accept: true })).status, 204);
  const p = await preview();
  assert.deepEqual(p.missing, ['rate', 'beneficiary', 'basis', 'collector', 'retail']);
  assert.equal(p.amount, null);
  const issue = await partner.post(`${P()}/statements`, { month: LAST_MONTH });
  assert.equal(issue.status, 400);
  assert.match(issue.body.error, /missing: rate, beneficiary/);
});

test('the month\'s figures come from the Spa\'s books, with retail separated', async () => {
  const f = (await preview()).figures;
  assert.equal(Number(f.net), 40000 + 10000 + 8000);
  assert.equal(Number(f.serviceCharge), 4000 + 1000 + 800);
  assert.equal(Number(f.vat), 3300 + 825 + 660);
  assert.equal(Number(f.retailNet), 10000 + 5000);
  assert.equal(Number(f.retailServiceCharge), 1000 + 500);
  assert.equal(Number(f.retailVat), 825 + 412.5);
  assert.equal(f.appointments, 1);
  assert.equal(f.tickets, 1);
  assert.equal(Number((await preview(THIS_MONTH)).figures.net), 0);
});

const agree = async (by, other, terms) => {
  assert.equal((await propose(by, terms)).status, 201);
  assert.equal((await other.post(`${P()}/agreements/${(await openProposal()).id}/decide`, { accept: true, note: 'Agreed' })).status, 204);
};

test('the base, the share, and who pays whom follow the terms', async () => {
  // 20% to the Owner of net service revenue (no retail); the partner collects, so the partner pays the share.
  await agree(owner, partner, { ratePct: 20, beneficiary: 'owner', basis: 'net', collector: 'partner', includeRetail: false });
  let p = await preview();
  assert.deepEqual(p.missing, []);
  assert.equal(Number(p.base), 58000 - 15000);
  assert.equal(Number(p.share), 8600);
  assert.deepEqual([p.payer, p.payee, Number(p.amount)], ['partner', 'owner', 8600]);

  // Gross with retail, and the Owner collects everything: the Owner pays the partner the rest.
  await agree(partner, owner, { ratePct: 20, beneficiary: 'owner', basis: 'gross', collector: 'owner', includeRetail: true });
  p = await preview();
  assert.equal(Number(p.base), 58000 + 5800 + 4785);
  assert.equal(Number(p.share), 13717);
  assert.deepEqual([p.payer, p.payee, Number(p.amount)], ['owner', 'partner', 68585 - 13717]);

  // Back to the first terms; the latest agreed version for the month wins.
  await agree(owner, partner, { ratePct: 20, beneficiary: 'owner', basis: 'net', collector: 'partner', includeRetail: false });
  const list = (await owner.get(`${P()}/agreements`)).body;
  assert.equal(list.agreements.length, 4);
  assert.equal(list.currentId, list.agreements[0].id);
});

test('statements: only for ended months; issued by one side, agreed by the other; withdrawable until agreed', async () => {
  assert.match((await partner.post(`${P()}/statements`, { month: THIS_MONTH })).body.error, /once it has ended/);
  const first = await partner.post(`${P()}/statements`, { month: LAST_MONTH });
  assert.equal(first.status, 201);
  assert.equal((await owner.post(`${P()}/statements`, { month: LAST_MONTH })).status, 409);
  assert.ok((await owner.get('/api/notifications')).body.items.some((n) => n.kind === 'settlement' && n.title === 'Settlement statement issued'));
  assert.equal((await partner.post(`${P()}/statements/${first.body.id}/agree`)).status, 403, 'the other side agrees');
  assert.equal((await owner.post(`${P()}/statements/${first.body.id}/withdraw`)).status, 403, 'only the issuer withdraws');
  assert.equal((await partner.post(`${P()}/statements/${first.body.id}/withdraw`)).status, 204);

  const s = (await owner.post(`${P()}/statements`, { month: LAST_MONTH })).body;
  assert.equal((await owner.post(`${P()}/statements/${s.id}/payment`, { method: 'transfer' })).status, 400, 'agree first');
  assert.equal((await partner.post(`${P()}/statements/${s.id}/agree`)).status, 204);
  let b = await tb();
  assert.equal(b['5400'], 8600, 'the share accrued as an expense of the Spa');
  assert.equal(b['2300'], -8600, 'owed to the Owner');
  assert.equal((await partner.post(`${P()}/statements/${s.id}/withdraw`)).status, 403);

  assert.equal((await partner.post(`${P()}/statements/${s.id}/payment`, { method: 'transfer', reference: 'TRF-9001' })).status, 204);
  b = await tb();
  assert.equal(b['2300'], 0);
  const st = (await owner.get(`${P()}/statements`)).body;
  assert.deepEqual(st.map((x) => x.status), ['paid', 'withdrawn']);
  assert.equal(st[0].payment_reference, 'TRF-9001');
  assert.equal(Number(st[0].figures.figures.net), 58000, 'figures frozen on the statement');
});

test('every change is in the audit chain', async () => {
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});
