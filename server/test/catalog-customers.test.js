import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools } from './helpers.js';

let seed, owner, it, partner, ada;
before(async () => {
  seed = await resetDatabase();
  [owner, it, partner] = await Promise.all([
    signIn('owner@test.local'), signIn('it@test.local'), signIn('partner@test.local')]);
});
after(closePools);

test('suppliers: shared master, unit-private account terms', async () => {
  const s = await owner.post('/api/suppliers', { name: 'Lagos Beverages Ltd', phone: '0801 234 5678' });
  assert.equal(s.status, 201);
  assert.equal((await owner.put(`/api/suppliers/${s.body.id}/units/${seed.units.FNB}`, { accountNumber: 'LB-001', paymentTermsDays: 30 })).status, 200);
  assert.equal((await partner.put(`/api/suppliers/${s.body.id}/units/${seed.units.SPA}`, { accountNumber: 'SPA-77', paymentTermsDays: 7 })).status, 200);

  const asPartner = (await partner.get(`/api/suppliers?businessUnitId=${seed.units.FNB}`)).body.find((x) => x.id === s.body.id);
  assert.equal(asPartner.name, 'Lagos Beverages Ltd', 'partner sees the shared supplier');
  assert.equal(asPartner.account_number, null, "but not F&B's account with it");
  const ownerOnSpa = (await owner.get(`/api/suppliers?businessUnitId=${seed.units.SPA}`)).body.find((x) => x.id === s.body.id);
  assert.equal(ownerOnSpa.account_number, 'SPA-77', 'owner can read Spa finance');
  assert.equal((await owner.put(`/api/suppliers/${s.body.id}/units/${seed.units.SPA}`, { accountNumber: 'HACK' })).status, 403);
  assert.equal((await partner.patch(`/api/suppliers/${s.body.id}`, { name: 'Renamed', rowVersion: s.body.row_version })).status, 404,
    'group suppliers are edited by the owner only');
});

test('customers: one identity shared across units', async () => {
  const created = await owner.post('/api/customers', { fullName: 'Ada Obi', phone: '+234 803 555 0101' });
  assert.equal(created.status, 201);
  ada = created.body;

  const dup = await partner.post('/api/customers', { fullName: 'Ada O.', phone: '234-803-555-0101' });
  assert.equal(dup.status, 409, 'same phone in a different format is recognised');
  assert.equal(dup.body.details.existing.id, ada.id);

  const found = (await partner.get('/api/customers?q=0803%20555%200101')).body;
  assert.deepEqual(found.map((c) => c.id), [ada.id], 'partner finds the shared customer by local-format phone');

  const local = await partner.post('/api/customers', { fullName: 'Ada', phone: '0803 555 0101' });
  assert.equal(local.status, 409, 'local and international formats are the same number');
});

test('customer notes are private to each unit', async () => {
  assert.equal((await owner.put(`/api/customers/${ada.id}/profiles/${seed.units.FNB}`, { notes: 'Prefers sparkling water', tags: ['vip'] })).status, 200);
  assert.equal((await partner.put(`/api/customers/${ada.id}/profiles/${seed.units.SPA}`, { notes: 'Likes firm pressure' })).status, 200);

  const asPartner = (await partner.get(`/api/customers/${ada.id}`)).body;
  assert.deepEqual(asPartner.profiles.map((p) => p.business_unit_name), ['Spa']);

  const asOwner = (await owner.get(`/api/customers/${ada.id}`)).body;
  assert.deepEqual(asOwner.profiles.map((p) => p.business_unit_name).sort(), ['Food & Beverage', 'Spa']);
  assert.equal(asOwner.profiles.find((p) => p.business_unit_name === 'Spa').can_edit, false);
  assert.equal((await owner.put(`/api/customers/${ada.id}/profiles/${seed.units.SPA}`, { notes: 'changed' })).status, 403);
});

test('IT cannot see customers at all', async () => {
  assert.deepEqual((await it.get('/api/customers')).body, []);
  assert.equal((await it.get(`/api/customers/${ada.id}`)).status, 404);
  assert.equal((await it.post('/api/customers', { fullName: 'X Y', phone: '0800000000' })).status, 403);
});

test('a customer needs a phone or an email', async () => {
  assert.equal((await owner.post('/api/customers', { fullName: 'No Contact' })).status, 400);
});
