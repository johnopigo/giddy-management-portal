import { getAppPool } from './pool.js';

/**
 * Runs fn(client) inside one transaction with the caller's identity set for
 * row-level security. Settings are transaction-local, so a pooled connection
 * never carries one user's identity into another user's request.
 *
 * @param {{userId?: string|null, tenantId?: string|null, correlationId?: string, ip?: string}} ctx
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @template T
 */
export async function withContext(ctx, fn) {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true),
              set_config('app.correlation_id', $3, true), set_config('app.ip', $4, true)`,
      [ctx.userId ?? '', ctx.tenantId ?? '', ctx.correlationId ?? '', ctx.ip ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
