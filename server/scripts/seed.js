// Seeds a development tenant. Safe to re-run: does nothing if a tenant already exists.
import pg from 'pg';
import { config } from '../src/config.js';
import { bootstrapTenant } from '../src/db/bootstrap.js';

const DEV_PASSWORD = process.env.SEED_PASSWORD ?? 'GiddyDev2026';

const client = new pg.Client({ connectionString: config.ownerDatabaseUrl });
await client.connect();
try {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM tenant');
  if (rows[0].n > 0) {
    console.log('A tenant already exists; nothing to seed.');
  } else {
    await client.query('BEGIN');
    const result = await bootstrapTenant(client, {
      tenantName: 'Giddy Luxury Apartments',
      users: [
        { key: 'owner', email: 'owner@giddy.local', fullName: 'System Owner', role: 'SYSTEM_OWNER', password: DEV_PASSWORD, mustChangePassword: false },
        { key: 'it', email: 'it@giddy.local', fullName: 'IT Administrator', role: 'IT_ADMIN', password: DEV_PASSWORD, mustChangePassword: false },
        { key: 'partner', email: 'partner@giddy.local', fullName: 'Spa Partner', role: 'BU_PARTNER', unit: 'SPA', password: DEV_PASSWORD, mustChangePassword: false },
      ],
    });
    await client.query('COMMIT');
    console.log('Seeded tenant', result.tenantId);
    console.log(`Sign in as owner@giddy.local, it@giddy.local or partner@giddy.local with password ${DEV_PASSWORD}`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err);
  process.exitCode = 1;
} finally {
  await client.end();
}
