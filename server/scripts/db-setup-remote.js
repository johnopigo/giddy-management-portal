// Prepares a managed PostgreSQL database (Neon, Supabase, DigitalOcean, …) for the portal, from
// the admin connection string the provider gives you. Run it once from any computer with Node.js 22:
//
//   ADMIN_DATABASE_URL='postgresql://neondb_owner:…@ep-….eu-central-1.aws.neon.tech/neondb?sslmode=require' \
//     npm run db:setup-remote
//
// It creates the two logins the portal uses — giddy_owner (owns the tables, runs migrations) and
// giddy_app (serves requests; row-level security always applies to it) — with new random
// passwords, creates the database, applies every migration, and prints the two connection strings
// to put in the hosting panel. Run again to rotate both passwords (the data is kept).
import crypto from 'node:crypto';
import pg from 'pg';

const adminUrl = process.env.ADMIN_DATABASE_URL;
const dbName = process.env.DB_NAME ?? 'giddy';
if (!adminUrl) {
  console.error('Set ADMIN_DATABASE_URL to the admin connection string from your database provider.');
  process.exit(2);
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) {
  console.error('DB_NAME may use lower-case letters, digits and underscores only.');
  process.exit(2);
}

const urlFor = (user, password, database) => {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
};
const ident = (s) => `"${s.replace(/"/g, '""')}"`;
const literal = (s) => `'${s.replace(/'/g, "''")}'`;
const password = () => crypto.randomBytes(24).toString('hex');

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const pw = { giddy_owner: password(), giddy_app: password() };
try {
  const me = (await admin.query('SELECT current_user AS u')).rows[0].u;
  for (const [role, extra] of [['giddy_owner', 'NOSUPERUSER NOCREATEROLE'], ['giddy_app', 'NOSUPERUSER NOCREATEROLE NOBYPASSRLS']]) {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rows.length > 0;
    // Only a new login gets its attributes; changing them later needs a superuser, which managed providers don't give.
    await admin.query(exists ? `ALTER ROLE ${ident(role)} PASSWORD ${literal(pw[role])}`
      : `CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(pw[role])} ${extra}`);
    console.log(`${exists ? 'Updated' : 'Created'} login ${role}`);
  }
  // Creating a database owned by giddy_owner needs the admin to be a member of it (PostgreSQL 16+).
  await admin.query(`GRANT giddy_owner TO ${ident(me)}`).catch(() => {});

  const dbExists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rows.length > 0;
  if (!dbExists) {
    await admin.query(`CREATE DATABASE ${ident(dbName)} OWNER giddy_owner`);
    console.log(`Created database ${dbName}`);
  } else {
    await admin.query(`GRANT ALL ON DATABASE ${ident(dbName)} TO giddy_owner`);
    console.log(`Using the existing database ${dbName}`);
  }
} finally {
  await admin.end();
}

const ownerUrl = urlFor('giddy_owner', pw.giddy_owner, dbName);
const appUrl = urlFor('giddy_app', pw.giddy_app, dbName);

// Inside the new database, as its owner: only the portal's two logins may use the public schema.
const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
try {
  await owner.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO giddy_app;
                     REVOKE ALL ON DATABASE ${ident(dbName)} FROM PUBLIC; GRANT CONNECT ON DATABASE ${ident(dbName)} TO giddy_app`);
} finally {
  await owner.end();
}

const { migrate } = await import('../src/db/migrate.js');
await migrate(ownerUrl);

console.log(`
The database is ready. Put these two settings in your hosting panel (keep them secret):

DATABASE_OWNER_URL=${ownerUrl}
DATABASE_APP_URL=${appUrl}
`);
