import pg from 'pg';
import request from 'supertest';

// Tests always run against a dedicated database that is wiped before each test file.
process.env.DATABASE_OWNER_URL = process.env.TEST_DATABASE_OWNER_URL
  ?? 'postgres://giddy_owner:change-me@localhost:5432/giddy_test';
process.env.DATABASE_APP_URL = process.env.TEST_DATABASE_APP_URL
  ?? 'postgres://giddy_app:change-me@localhost:5432/giddy_test';

const { migrate } = await import('../src/db/migrate.js');
const { bootstrapTenant } = await import('../src/db/bootstrap.js');
const { createApp } = await import('../src/app.js');
const { closePools } = await import('../src/db/pool.js');

export const PASSWORD = 'TestPassw0rd';

export async function ownerQuery(sql, params) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

/** Drops everything, re-applies migrations and seeds one tenant with owner, IT and spa partner. */
export async function resetDatabase() {
  // Drop every schema the owner role created (sec, inv, fin, pos, …) plus public, then start clean.
  await ownerQuery(`DO $$ DECLARE s text; BEGIN
      FOR s IN SELECT nspname FROM pg_namespace WHERE nspowner = 'giddy_owner'::regrole AND nspname <> 'public' LOOP
        EXECUTE format('DROP SCHEMA %I CASCADE', s);
      END LOOP;
    END $$;
    DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO giddy_app;`);
  await migrate(process.env.DATABASE_OWNER_URL, () => {});
  const c = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const seeded = await bootstrapTenant(c, {
      tenantName: 'Giddy Test',
      users: [
        { key: 'owner', email: 'owner@test.local', fullName: 'Owner', role: 'SYSTEM_OWNER', password: PASSWORD, mustChangePassword: false },
        { key: 'it', email: 'it@test.local', fullName: 'IT Admin', role: 'IT_ADMIN', password: PASSWORD, mustChangePassword: false },
        { key: 'partner', email: 'partner@test.local', fullName: 'Spa Partner', role: 'BU_PARTNER', unit: 'SPA', password: PASSWORD, mustChangePassword: false },
      ],
    });
    await c.query('COMMIT');
    return seeded;
  } finally {
    await c.end();
  }
}

export const app = createApp();

/** A supertest agent that keeps the session cookie and sends the CSRF header. */
export async function signIn(email, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('x-requested-with', 'giddy').send({ email, password });
  if (res.status !== 204) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return wrap(agent);
}

export function wrap(agent) {
  const h = (req) => req.set('x-requested-with', 'giddy');
  return {
    get: (url) => agent.get(url),
    post: (url, body) => h(agent.post(url)).send(body ?? {}),
    put: (url, body) => h(agent.put(url)).send(body ?? {}),
    patch: (url, body) => h(agent.patch(url)).send(body ?? {}),
    delete: (url) => h(agent.delete(url)),
  };
}

export async function roleIdByCode(api, code) {
  const res = await api.get('/api/roles');
  return res.body.find((r) => r.code === code).id;
}

export { request, closePools };

/** Runs raw SQL as the API role inside a user's security context (for testing database-level rules). */
export async function asUser(userId, tenantId, sql, params) {
  const { withContext } = await import('../src/db/context.js');
  return withContext({ userId, tenantId }, (c) => c.query(sql, params));
}

/** Creates a user, grants a unit role (owner-managed units activate immediately) and signs them in. */
export async function staffMember(admin, { email, role, businessUnitId, departmentId }) {
  const created = await admin.post('/api/users', { email, fullName: email.split('@')[0] });
  const roleId = await roleIdByCode(admin, role);
  const grant = await admin.post('/api/assignments', { userId: created.body.user.id, roleId, businessUnitId, departmentId });
  if (grant.status !== 201) throw new Error(`grant failed: ${JSON.stringify(grant.body)}`);
  const api = await signIn(email, created.body.temporaryPassword);
  await api.post('/api/me/password', { currentPassword: created.body.temporaryPassword, newPassword: 'StaffPassw0rd' });
  return { api, userId: created.body.user.id };
}
