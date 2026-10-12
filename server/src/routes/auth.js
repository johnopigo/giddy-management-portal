import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { newSessionToken, hashToken } from '../auth/tokens.js';
import { parse } from '../lib/validate.js';
import { HttpError, unauthorized } from '../lib/errors.js';
import { SESSION_COOKIE } from '../middleware/context.js';

const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export function authRoutes() {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.isTest ? 1000 : 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Try again in a minute.' },
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const result = await req.db(async (c) => {
      const { rows } = await c.query('SELECT * FROM sec.auth_lookup($1)', [email]);
      const user = rows[0];
      const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user) return { error: unauthorized('Email or password is incorrect.') };
      if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
        return { error: new HttpError(423, 'Account is temporarily locked after repeated failed sign-ins. Try again later.') };
      }
      if (!ok || !user.is_active) {
        await c.query('SELECT sec.auth_login_failed($1)', [user.user_id]);
        return { error: unauthorized('Email or password is incorrect.') };
      }
      const token = newSessionToken();
      await c.query('SELECT sec.auth_login_succeeded($1, $2, $3::interval, $4::inet, $5)', [
        user.user_id, hashToken(token), `${config.sessionTtlHours} hours`, req.ip ?? null,
        req.get('user-agent')?.slice(0, 300) ?? null,
      ]);
      return { token };
    });
    // Failed-attempt counters must persist, so the transaction commits before the error is sent.
    if (result.error) throw result.error;

    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.cookieSecure,
      maxAge: config.sessionTtlHours * 3600_000,
      path: '/',
    });
    res.status(204).end();
  });

  router.post('/logout', async (req, res) => {
    if (req.sessionToken) {
      await req.db((c) => c.query('SELECT sec.session_revoke($1)', [hashToken(req.sessionToken)]));
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  });

  return router;
}
