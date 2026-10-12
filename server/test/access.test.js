// The partnership model: who can read and change what, enforced by row-level security.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools } from './helpers.js';

let seed, owner, it, partner;
before(async () => {
  seed = await resetDatabase();
  [owner, it, partner] = await Promise.all([
    signIn('owner@test.local'), signIn('it@test.local'), signIn('partner@test.local')]);
});
after(closePools);

const settingsUrl = (unit) => `/api/org/business-units/${seed.units[unit]}/settings`;

test('owner reads and writes settings in owner-managed units', async () => {
  for (const unit of ['APARTMENTS', 'FNB', 'STUDIO']) {
    assert.equal((await owner.get(settingsUrl(unit))).body.length, 2, unit);
    assert.equal((await owner.put(`${settingsUrl(unit)}/tax.vat_pct`, { value: 7.5 })).status, 200, unit);
  }
});

test('owner reads Spa settings but cannot change them', async () => {
  assert.equal((await owner.get(settingsUrl('SPA'))).body.length, 2);
  const res = await owner.put(`${settingsUrl('SPA')}/tax.vat_pct`, { value: 0 });
  assert.equal(res.status, 403);
  const after = await partner.get(settingsUrl('SPA'));
  assert.equal(after.body.find((s) => s.key === 'tax.vat_pct').value, 7.5, 'value unchanged');
});

test('spa partner reads and writes Spa settings only', async () => {
  assert.equal((await partner.put(`${settingsUrl('SPA')}/charges.service_pct`, { value: 12 })).status, 200);
  for (const unit of ['APARTMENTS', 'FNB', 'STUDIO']) {
    assert.deepEqual((await partner.get(settingsUrl(unit))).body, [], `${unit} hidden from partner`);
    assert.equal((await partner.put(`${settingsUrl(unit)}/tax.vat_pct`, { value: 0 })).status, 403, unit);
  }
});

test('IT admin sees no business data in any unit', async () => {
  for (const unit of ['APARTMENTS', 'FNB', 'STUDIO', 'SPA']) {
    assert.deepEqual((await it.get(settingsUrl(unit))).body, [], unit);
  }
  const me = await it.get('/api/me');
  assert.deepEqual(me.body.scope, []);
});

test('departments: owner cannot add one to the Spa; the partner can', async () => {
  const body = { businessUnitId: seed.units.SPA, branchId: seed.branchId, name: 'Steam Room', kind: 'treatment' };
  assert.equal((await owner.post('/api/org/departments', body)).status, 403);
  assert.equal((await partner.post('/api/org/departments', body)).status, 201);
  const fnb = { businessUnitId: seed.units.FNB, branchId: seed.branchId, name: 'Pastry', kind: 'kitchen' };
  assert.equal((await partner.post('/api/org/departments', fnb)).status, 403);
  assert.equal((await owner.post('/api/org/departments', fnb)).status, 201);
});

test('only the owner manages business units', async () => {
  const body = {
    legalEntityId: (await owner.get('/api/org')).body.legalEntities[0].id,
    code: 'EVENTS', name: 'Events Hall', unitType: 'content_studio', managementModel: 'owner',
  };
  assert.equal((await partner.post('/api/org/business-units', body)).status, 403);
  assert.equal((await it.post('/api/org/business-units', body)).status, 403);
  assert.equal((await owner.post('/api/org/business-units', body)).status, 201);
});

test('owner scope for a newly added owner unit is granted automatically', async () => {
  const me = await owner.get('/api/me');
  const events = me.body.scope.find((s) => s.code === 'EVENTS');
  assert.equal(events.access.FIN, 'write');
});

test('owner never gets sensitive (SEN) access to the Spa', async () => {
  const spa = (await owner.get('/api/me')).body.scope.find((s) => s.code === 'SPA');
  assert.deepEqual(spa.access, { OPS: 'read', FIN: 'read', CFG: 'read' });
});
