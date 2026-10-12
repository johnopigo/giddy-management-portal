// Protected accounts: IT manages ordinary accounts but cannot take over owner or partner accounts.
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

const userByEmail = async (api, email) => (await api.get('/api/users')).body.find((u) => u.email === email);

test('owner and partner accounts are flagged as protected', async () => {
  assert.equal((await userByEmail(it, 'owner@test.local')).is_protected, true);
  assert.equal((await userByEmail(it, 'partner@test.local')).is_protected, true);
  assert.equal((await userByEmail(it, 'it@test.local')).is_protected, false);
});

test('IT cannot reset the password of, or deactivate, a protected account', async () => {
  assert.equal((await it.post(`/api/users/${seed.users.partner}/reset-password`)).status, 403);
  assert.equal((await it.post(`/api/users/${seed.users.owner}/reset-password`)).status, 403);
  const p = await userByEmail(it, 'partner@test.local');
  assert.equal((await it.patch(`/api/users/${p.id}`, { isActive: false, rowVersion: p.row_version })).status, 403);
  assert.equal((await partner.get('/api/me')).status, 200, 'partner still signed in');
});

test('IT cannot revoke a restricted role', async () => {
  const grants = (await it.get(`/api/assignments?userId=${seed.users.partner}`)).body;
  assert.equal((await it.post(`/api/assignments/${grants[0].id}/revoke`)).status, 403);
});

test('the partner sees the names of people who requested Spa grants', async () => {
  const created = await it.post('/api/users', { email: 'spa2@test.local', fullName: 'Spa Two' });
  const roles = (await it.get('/api/roles')).body;
  const frontDesk = roles.find((r) => r.code === 'FRONT_DESK').id;
  await it.post('/api/assignments', { userId: created.body.user.id, roleId: frontDesk, businessUnitId: seed.units.SPA });
  const pending = (await partner.get('/api/assignments?status=pending_approval')).body;
  assert.equal(pending[0].requested_by_name, 'IT Admin');
  const audit = (await partner.get('/api/audit?entity=user_role_assignment')).body;
  assert.ok(audit.some((e) => e.user_name === 'IT Admin'));
});

test('the owner can reset a protected account (e.g. a locked-out partner)', async () => {
  // This also signs the partner out everywhere, so it runs after the partner-session tests.
  const res = await owner.post(`/api/users/${seed.users.partner}/reset-password`);
  assert.equal(res.status, 200);
  assert.ok(res.body.temporaryPassword);
});

test('the owner cannot revoke their own owner role', async () => {
  const grants = (await owner.get(`/api/assignments?userId=${seed.users.owner}`)).body;
  assert.equal((await owner.post(`/api/assignments/${grants[0].id}/revoke`)).status, 403);
});

test('IT can still reset ordinary accounts', async () => {
  const created = await it.post('/api/users', { email: 'staff@test.local', fullName: 'Staff' });
  assert.equal((await it.post(`/api/users/${created.body.user.id}/reset-password`)).status, 200);
});
