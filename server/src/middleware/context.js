import crypto from 'node:crypto';
import { withContext } from '../db/context.js';
import { hashToken } from '../auth/tokens.js';
import { unauthorized, forbidden, HttpError } from '../lib/errors.js';

export const SESSION_COOKIE = 'giddy_session';

// Secret parts of public addresses (a guest's booking link, a payment reference) are not logged.
const redact = (path) => path.replace(/^(\/api\/public\/(?:manage|test-payments))\/[^/]+/, '$1/…');

/** Attaches a correlation id and a req.db(fn) helper that runs fn inside the caller's security context. */
export function requestContext(req, res, next) {
  req.correlationId = req.get('x-correlation-id')?.slice(0, 64) || crypto.randomUUID();
  res.set('x-correlation-id', req.correlationId);
  if (process.env.ACCESS_LOG === 'true') {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      // One JSON line per request; never the body, cookies or query string (they can carry personal data).
      console.log(JSON.stringify({
        at: new Date().toISOString(), id: req.correlationId, method: req.method, path: redact(req.originalUrl.split('?')[0]),
        status: res.statusCode, ms: Number((process.hrtime.bigint() - started) / 1_000_000n), user: req.auth?.userId ?? null,
      }));
    });
  }
  req.db = (fn) =>
    withContext(
      { userId: req.auth?.userId, tenantId: req.auth?.tenantId, correlationId: req.correlationId, ip: req.ip },
      fn,
    );
  next();
}

/** Resolves the session cookie to a user. Leaves req.auth undefined when there is no valid session. */
export async function authenticate(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  try {
    const row = await req.db(async (c) => {
      const { rows } = await c.query('SELECT * FROM sec.session_resolve($1)', [hashToken(token)]);
      return rows[0];
    });
    if (row) {
      req.auth = { userId: row.user_id, tenantId: row.tenant_id, mustChangePassword: row.must_change_password };
      req.sessionToken = token;
    }
    next();
  } catch (err) {
    next(err);
  }
}

const PASSWORD_CHANGE_ALLOWED = new Set(['/api/me', '/api/me/password', '/api/auth/logout']);

export function requireAuth(req, res, next) {
  if (!req.auth) return next(unauthorized());
  const fullPath = req.originalUrl.split('?')[0].replace(/\/$/, '');
  if (req.auth.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(fullPath)) {
    return next(new HttpError(403, 'You must change your password before continuing.', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  }
  next();
}

/**
 * CSRF defence: state-changing requests must carry a custom header. Browsers will not send
 * custom headers cross-site without a CORS preflight, which this API never approves.
 */
export function requireCsrfHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Paystack's server-to-server webhook is authenticated by its signature instead.
  if (req.originalUrl.split('?')[0] === '/api/public/paystack/webhook') return next();
  if (req.get('x-requested-with') !== 'giddy') return next(forbidden('Missing request header.'));
  next();
}
