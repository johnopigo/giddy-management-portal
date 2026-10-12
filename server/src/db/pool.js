import pg from 'pg';
import { config } from '../config.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of shifting them through local time.
pg.types.setTypeParser(1082, (value) => value);

let appPool;

/** Pool for request handling. Connects as giddy_app, so row-level security always applies. */
export function getAppPool() {
  appPool ??= new pg.Pool({ connectionString: config.appDatabaseUrl, max: 20 });
  return appPool;
}

export async function closePools() {
  await appPool?.end();
  appPool = undefined;
}
