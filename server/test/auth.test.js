import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, signIn, app, request, closePools, PASSWORD, wrap } from './helpers.js';

before(resetDatabase);
after(closePools);

test('valid credentials sign in and /me returns the user', async () => {
  const api = await signIn('owner@test.local');
  const res = await api.get('/api/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'owner@test.local');
});

test('requests without a session are rejected', async () => {
  const res = await request(app).get('/api/me');
  assert.equal(res.status, 401);
});

test('state-changing requests without the CSRF header are rejected', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'owner@test.local', password: PASSWORD });
  assert.equal(res.status, 403);
});

test('wrong password returns 401 and the account locks after 5 failures', async () => {
  const attempt = (password) => request(app).post('/api/auth/login')
    .set('x-requested-with', 'giddy').send({ email: 'it@test.local', password });
  for (let i = 0; i < 5; i++) assert.equal((await attempt('wrong-password-1')).status, 401);
  assert.equal((await attempt(PASSWORD)).status, 423, 'even the right password is refused while locked');
});

test('unknown email gets the same 401 as a wrong password', async () => {
  const res = await request(app).post('/api/auth/login')
    .set('x-requested-with', 'giddy').send({ email: 'nobody@test.local', password: 'whatever123' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Email or password is incorrect.');
});

test('logout ends the session', async () => {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('x-requested-with', 'giddy').send({ email: 'owner@test.local', password: PASSWORD });
  const api = wrap(agent);
  assert.equal((await api.post('/api/auth/logout')).status, 204);
  assert.equal((await api.get('/api/me')).status, 401);
});

test('a new user must change the temporary password before doing anything else', async () => {
  const owner = await signIn('owner@test.local');
  const created = await owner.post('/api/users', { email: 'new@test.local', fullName: 'New Person' });
  assert.equal(created.status, 201);
  const { temporaryPassword } = created.body;

  const fresh = await signIn('new@test.local', temporaryPassword);
  assert.equal((await fresh.get('/api/org')).status, 403);
  assert.equal((await fresh.get('/api/me')).body.user.must_change_password, true);

  const weak = await fresh.post('/api/me/password', { currentPassword: temporaryPassword, newPassword: 'short' });
  assert.equal(weak.status, 400);
  const ok = await fresh.post('/api/me/password', { currentPassword: temporaryPassword, newPassword: 'BrandNewPass9' });
  assert.equal(ok.status, 204);
  assert.equal((await fresh.get('/api/org')).status, 200);
});
