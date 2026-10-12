import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../auth/password.js';
import { hashToken } from '../auth/tokens.js';
import { parse } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';

const passwordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().max(200) });

export function meRoutes() {
  const router = Router();

  router.get('/', async (req, res) => {
    const data = await req.db(async (c) => {
      const user = (await c.query(
        `SELECT u.id, u.email, u.full_name, u.must_change_password, t.id AS tenant_id, t.name AS tenant_name
           FROM app_user u JOIN tenant t ON t.id = u.tenant_id WHERE u.id = sec.current_user_id()`,
      )).rows[0];
      const assignments = (await c.query(
        `SELECT a.id, a.status, r.code AS role_code, r.name AS role_name,
                a.business_unit_id, bu.name AS business_unit_name
           FROM user_role_assignment a
           JOIN role r ON r.id = a.role_id
           LEFT JOIN business_unit bu ON bu.id = a.business_unit_id
          WHERE a.user_id = sec.current_user_id() AND a.status IN ('active', 'pending_approval')
          ORDER BY r.name`,
      )).rows;
      const scope = (await c.query(
        `SELECT s.business_unit_id, bu.code, bu.name, bu.unit_type, bu.management_model,
                jsonb_object_agg(s.data_class, s.access_level) AS access
           FROM user_access_scope s JOIN business_unit bu ON bu.id = s.business_unit_id
          WHERE s.user_id = sec.current_user_id()
          GROUP BY s.business_unit_id, bu.code, bu.name, bu.unit_type, bu.management_model
          ORDER BY bu.name`,
      )).rows;
      // Administrative permissions held tenant-wide (unit-specific ones are checked per request).
      const permissions = (await c.query(
        `SELECT DISTINCT rp.permission_code AS code, a.business_unit_id
           FROM user_role_assignment a JOIN role_permission rp ON rp.role_id = a.role_id
           JOIN permission p ON p.code = rp.permission_code AND p.data_class IS NULL
          WHERE a.user_id = sec.current_user_id() AND a.status = 'active'`,
      )).rows;
      return { user, assignments, scope, permissions };
    });
    res.json(data);
  });

  router.post('/password', async (req, res) => {
    const { currentPassword, newPassword } = parse(passwordSchema, req.body);
    const weakness = validatePasswordStrength(newPassword);
    if (weakness) throw badRequest(weakness);
    if (newPassword === currentPassword) throw badRequest('Choose a password different from the current one.');
    const newHash = await hashPassword(newPassword);
    await req.db(async (c) => {
      const { email } = (await c.query('SELECT email FROM app_user WHERE id = sec.current_user_id()')).rows[0];
      const { password_hash } = (await c.query('SELECT password_hash FROM sec.auth_lookup($1)', [email])).rows[0];
      if (!(await verifyPassword(currentPassword, password_hash))) throw badRequest('Current password is incorrect.');
      await c.query('SELECT sec.change_own_password($1, $2)', [newHash, hashToken(req.sessionToken)]);
      await c.query(`SELECT sec.audit_event('password_changed', 'app_user', sec.current_user_id()::text, NULL, NULL)`);
    });
    res.status(204).end();
  });

  return router;
}
