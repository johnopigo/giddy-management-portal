import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, ownerQuery } from './helpers.js';

let seed, owner, it, partner;
before(async () => {
  seed = await resetDatabase();
  [owner, it, partner] = await Promise.all([
    signIn('owner@test.local'), signIn('it@test.local'), signIn('partner@test.local')]);
});
after(closePools);

test('changes are logged with who made them and the before/after values', async () => {
  await partner.put(`/api/org/business-units/${seed.units.SPA}/settings/charges.service_pct`, { value: 15 });
  const log = await partner.get('/api/audit?entity=business_unit_setting');
  const entry = log.body.find((e) => e.entity_id === `${seed.units.SPA}:charges.service_pct` && e.action === 'update');
  assert.ok(entry);
  assert.equal(entry.user_name, 'Spa Partner');
  assert.equal(entry.before_data.value, 10);
  assert.equal(entry.after_data.value, 15);
});

test('password hashes never appear in the audit log', async () => {
  const { rows } = await ownerQuery(`SELECT count(*)::int AS n FROM audit_log WHERE after_data ? 'password_hash' OR before_data ? 'password_hash'`);
  assert.equal(rows[0].n, 0);
});

test('audit visibility follows the partnership model', async () => {
  const partnerRows = (await partner.get('/api/audit?limit=200')).body;
  assert.ok(partnerRows.length > 0);
  assert.ok(partnerRows.every((e) => e.business_unit_id === seed.units.SPA), 'partner sees only Spa entries');

  const ownerRows = (await owner.get('/api/audit?limit=200')).body;
  assert.ok(ownerRows.some((e) => e.business_unit_id === seed.units.SPA), 'owner can read Spa entries');
  assert.ok(ownerRows.some((e) => e.business_unit_id === seed.units.FNB));

  const itRows = (await it.get('/api/audit?limit=200')).body;
  assert.ok(itRows.length > 0);
  assert.ok(itRows.every((e) => ['app_user', 'user_role_assignment'].includes(e.entity)), 'IT sees only account and role changes');
});

test('the audit log cannot be changed, even by the table owner', async () => {
  await assert.rejects(ownerQuery('UPDATE audit_log SET action = $1 WHERE id = 1', ['x']), /append-only/);
  await assert.rejects(ownerQuery('DELETE FROM audit_log WHERE id = 1'), /append-only/);
});

test('a unit partner can verify the chain too', async () => {
  assert.deepEqual((await partner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });
});

test('the hash chain verifies, and detects tampering that bypasses the guard', async () => {
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: true, firstBrokenId: null });

  // Simulate someone with database-owner rights disabling the guard and editing history.
  await ownerQuery(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable;
                    UPDATE audit_log SET after_data = '{"value": 99}' WHERE id = 5;
                    ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable;`);
  assert.deepEqual((await owner.get('/api/audit/verify')).body, { intact: false, firstBrokenId: 5 });
});

test('users without audit permission cannot verify the chain', async () => {
  const created = await it.post('/api/users', { email: 'plain@test.local', fullName: 'Plain' });
  const plain = await signIn('plain@test.local', created.body.temporaryPassword);
  await plain.post('/api/me/password', { currentPassword: created.body.temporaryPassword, newPassword: 'PlainPassw0rd' });
  assert.equal((await plain.get('/api/audit/verify')).status, 403);
  assert.deepEqual((await plain.get('/api/audit')).body, []);
});
