// Creates the production tenant: the four units, the Owner, the IT administrator and the Spa
// partner's first user. Each person gets a random one-time password that must be changed at the
// first sign-in; nothing is printed except those passwords, once. Refuses to run if a tenant exists.
//
//   npm run setup-tenant -w server -- --name "Giddy Luxury Apartments" \
//     --owner "Jane Doe <owner@example.com>" --it "Sam IT <it@example.com>" --partner "Spa Partner <spa@example.com>"
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { config } from '../src/config.js';
import { bootstrapTenant } from '../src/db/bootstrap.js';

const { values: args } = parseArgs({
  options: { name: { type: 'string' }, owner: { type: 'string' }, it: { type: 'string' }, partner: { type: 'string' } },
});

function person(flag, value) {
  const m = /^\s*(.{2,120}?)\s*<\s*([^<>\s]+@[^<>\s]+\.[^<>\s]+)\s*>\s*$/.exec(value ?? '');
  if (!m) throw new Error(`--${flag} must look like "Full Name <email@example.com>"`);
  return { fullName: m[1], email: m[2].toLowerCase() };
}

// 16 characters from an alphabet without look-alikes (no 0/O, 1/l/I).
function oneTimePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(16), (b) => alphabet[b % alphabet.length]).join('');
}

let people;
try {
  if (!args.name || args.name.trim().length < 2) throw new Error('--name is required (the business name)');
  people = [
    { key: 'owner', role: 'SYSTEM_OWNER', ...person('owner', args.owner) },
    { key: 'it', role: 'IT_ADMIN', ...person('it', args.it) },
    { key: 'partner', role: 'BU_PARTNER', unit: 'SPA', ...person('partner', args.partner) },
  ];
  if (new Set(people.map((p) => p.email)).size !== people.length) throw new Error('the three people need different email addresses');
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const client = new pg.Client({ connectionString: config.ownerDatabaseUrl });
await client.connect();
try {
  if ((await client.query('SELECT count(*)::int AS n FROM tenant')).rows[0].n > 0) {
    throw new Error('A tenant already exists in this database; nothing was changed.');
  }
  const users = people.map((p) => ({ ...p, password: oneTimePassword(), mustChangePassword: true }));
  await client.query('BEGIN');
  const result = await bootstrapTenant(client, { tenantName: args.name.trim(), users });
  await client.query('COMMIT');
  const slug = (await client.query('SELECT public_slug FROM tenant WHERE id = $1', [result.tenantId])).rows[0].public_slug;
  console.log(`Created "${args.name.trim()}". Public booking page: ${config.publicUrl}/book/${slug} (each unit is off until enabled).`);
  console.log('\nOne-time passwords: give each to its owner privately. Each must be changed at the first sign-in.\n');
  for (const u of users) console.log(`  ${u.role.padEnd(13)} ${u.email.padEnd(32)} ${u.password}`);
  console.log('\nThese are not stored anywhere and will not be shown again. If one is lost, the Owner or IT can reset it.');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
