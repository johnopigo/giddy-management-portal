import crypto from 'node:crypto';
import { hashPassword } from '../auth/password.js';

/** One-time password shown to the administrator once; the user must replace it at first sign-in. */
export function generateTemporaryPassword() {
  return crypto.randomBytes(9).toString('base64url') + '7a';
}

export async function createUser(c, { email, fullName }) {
  const temporaryPassword = generateTemporaryPassword();
  const { rows } = await c.query(
    `INSERT INTO app_user (tenant_id, email, full_name, password_hash, must_change_password)
     VALUES (sec.current_tenant_id(), $1, $2, $3, true)
     RETURNING id, email, full_name, is_active, must_change_password, created_at`,
    [email, fullName, await hashPassword(temporaryPassword)],
  );
  return { user: rows[0], temporaryPassword };
}

export async function resetPassword(c, userId) {
  const temporaryPassword = generateTemporaryPassword();
  const { rowCount } = await c.query(
    `UPDATE app_user SET password_hash = $2, must_change_password = true WHERE id = $1`,
    [userId, await hashPassword(temporaryPassword)],
  );
  if (rowCount === 0) return null;
  await c.query('SELECT sec.revoke_user_sessions($1)', [userId]);
  return temporaryPassword;
}
