import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { createUser, resetPassword } from '../services/users.js';

const createSchema = z.object({ email: z.email().max(254), fullName: z.string().trim().min(2).max(120) });
const patchSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
  rowVersion: z.int(),
});

export function userRoutes() {
  const router = Router();

  // Row-level security decides which users appear: everyone for users.read holders,
  // only users with grants in their unit for partners, only yourself otherwise.
  router.get('/', async (req, res) => {
    const rows = await req.db(async (c) => (await c.query(
      `SELECT id, email, full_name, is_active, must_change_password, lockout_until, last_login_at, created_at, row_version,
              sec.is_protected_user(id) AS is_protected
         FROM app_user ORDER BY full_name`)).rows);
    res.json(rows);
  });

  router.post('/', async (req, res) => {
    const body = parse(createSchema, req.body);
    const result = await req.db((c) => createUser(c, body));
    res.status(201).json(result);
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(patchSchema, req.body);
    const row = await req.db(async (c) => {
      const updated = (await c.query(
        `UPDATE app_user SET full_name = coalesce($2, full_name), is_active = coalesce($3, is_active)
          WHERE id = $1 AND row_version = $4
          RETURNING id, email, full_name, is_active, must_change_password, row_version`,
        [id, body.fullName ?? null, body.isActive ?? null, body.rowVersion])).rows[0];
      if (updated && body.isActive === false) await c.query('SELECT sec.revoke_user_sessions($1)', [id]);
      return updated;
    });
    if (!row) throw notFound('User not found, or it was changed by someone else.');
    res.json(row);
  });

  router.post('/:id/reset-password', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const temporaryPassword = await req.db((c) => resetPassword(c, id));
    if (!temporaryPassword) throw notFound('User not found.');
    res.json({ temporaryPassword });
  });

  return router;
}
