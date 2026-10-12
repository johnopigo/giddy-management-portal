// Role assignment rules: IT assigns, partnership finance/config grants need partner approval.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, closePools, roleIdByCode } from './helpers.js';

let seed, owner, it, partner, frontDeskRole;
before(async () => {
  seed = await resetDatabase();
  [owner, it, partner] = await Promise.all([
    signIn('owner@test.local'), signIn('it@test.local'), signIn('partner@test.local')]);
  frontDeskRole = await roleIdByCode(it, 'FRONT_DESK');
});
after(closePools);

async function newUser(email) {
  const res = await it.post('/api/users', { email, fullName: email.split('@')[0] });
  assert.equal(res.status, 201);
  return res.body.user.id;
}

test('a Spa front-desk grant made by IT waits for the partner, then activates', async () => {
  const userId = await newUser('spa.reception@test.local');
  const created = await it.post('/api/assignments', { userId, roleId: frontDeskRole, businessUnitId: seed.units.SPA });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'pending_approval');

  // Not yet effective: the scope table has nothing for this user.
  const before = await it.get(`/api/assignments?userId=${userId}`);
  assert.equal(before.body[0].status, 'pending_approval');

  assert.equal((await it.post(`/api/assignments/${created.body.id}/approve`)).status, 403, 'IT cannot approve');
  assert.equal((await owner.post(`/api/assignments/${created.body.id}/approve`)).status, 403, 'owner cannot approve');

  // The partner can see the pending request and the person it is for.
  const pending = await partner.get('/api/assignments?status=pending_approval');
  assert.ok(pending.body.some((a) => a.id === created.body.id));
  assert.ok((await partner.get('/api/users')).body.some((u) => u.id === userId));

  const approved = await partner.post(`/api/assignments/${created.body.id}/approve`, { note: 'Agreed' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'active');
  assert.equal(approved.body.decided_by_name, 'Spa Partner');
});

test('the same grant in an owner-managed unit activates immediately', async () => {
  const userId = await newUser('fnb.cashier@test.local');
  const res = await it.post('/api/assignments', { userId, roleId: frontDeskRole, businessUnitId: seed.units.FNB });
  assert.equal(res.body.status, 'active');
});

test('a Spa grant with no finance or config access needs no approval', async () => {
  const userId = await newUser('therapist@test.local');
  const staffRole = await roleIdByCode(it, 'STAFF');
  const res = await it.post('/api/assignments', { userId, roleId: staffRole, businessUnitId: seed.units.SPA });
  assert.equal(res.body.status, 'active');
});

test('the partner can reject a pending grant', async () => {
  const userId = await newUser('maybe@test.local');
  const res = await it.post('/api/assignments', { userId, roleId: frontDeskRole, businessUnitId: seed.units.SPA });
  const rejected = await partner.post(`/api/assignments/${res.body.id}/reject`, { note: 'Not hired' });
  assert.equal(rejected.body.status, 'rejected');
  assert.equal((await partner.post(`/api/assignments/${res.body.id}/approve`)).status, 400, 'decision is final');
});

test('IT cannot assign restricted roles; the owner can', async () => {
  const userId = await newUser('auditor@test.local');
  const auditorRole = await roleIdByCode(it, 'GROUP_AUDITOR');
  assert.equal((await it.post('/api/assignments', { userId, roleId: auditorRole })).status, 403);
  assert.equal((await it.post('/api/assignments', { userId, roleId: await roleIdByCode(it, 'SYSTEM_OWNER') })).status, 403);
  assert.equal((await owner.post('/api/assignments', { userId, roleId: auditorRole })).body.status, 'active');
});

test('the partner role can only be granted in a partnership unit', async () => {
  const userId = await newUser('copartner@test.local');
  const partnerRole = await roleIdByCode(owner, 'BU_PARTNER');
  const res = await owner.post('/api/assignments', { userId, roleId: partnerRole, businessUnitId: seed.units.FNB });
  assert.equal(res.status, 400);
});

test('nobody can grant a role to themselves', async () => {
  const res = await it.post('/api/assignments', { userId: seed.users.it, roleId: frontDeskRole, businessUnitId: seed.units.FNB });
  assert.equal(res.status, 400);
});

test('scope must match the role: unit roles need a unit', async () => {
  const userId = await newUser('noscope@test.local');
  const res = await it.post('/api/assignments', { userId, roleId: frontDeskRole });
  assert.equal(res.status, 400);
});

test('the partner cannot grant roles, only approve them', async () => {
  const userId = await newUser('direct@test.local');
  const res = await partner.post('/api/assignments', { userId, roleId: frontDeskRole, businessUnitId: seed.units.SPA });
  assert.equal(res.status, 403);
});

test('revoking a grant removes access straight away', async () => {
  const userId = await newUser('leaver@test.local');
  const grant = await it.post('/api/assignments', { userId, roleId: frontDeskRole, businessUnitId: seed.units.FNB });
  assert.equal((await it.post(`/api/assignments/${grant.body.id}/revoke`)).body.status, 'revoked');
  const scope = await it.get(`/api/assignments?userId=${userId}&status=active`);
  assert.deepEqual(scope.body, []);
});

test('deactivating a user ends their sessions', async () => {
  const created = await it.post('/api/users', { email: 'temp@test.local', fullName: 'Temp' });
  const temp = await signIn('temp@test.local', created.body.temporaryPassword);
  assert.equal((await temp.get('/api/me')).status, 200);
  const user = (await it.get('/api/users')).body.find((u) => u.email === 'temp@test.local');
  assert.equal((await it.patch(`/api/users/${user.id}`, { isActive: false, rowVersion: user.row_version })).status, 200);
  assert.equal((await temp.get('/api/me')).status, 401);
});
