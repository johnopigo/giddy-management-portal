import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const createSchema = z.object({
  userId: z.uuid(),
  roleId: z.uuid(),
  businessUnitId: z.uuid().nullish(),
  branchId: z.uuid().nullish(),
  departmentId: z.uuid().nullish(),
});
const listQuery = z.object({
  status: z.enum(['pending_approval', 'active', 'rejected', 'revoked']).optional(),
  userId: z.uuid().optional(),
  businessUnitId: z.uuid().optional(),
});
const decisionSchema = z.object({ note: z.string().max(500).optional() });

const SELECT_ASSIGNMENT = `
  SELECT a.id, a.status, a.user_id, u.full_name AS user_name, u.email AS user_email,
         a.role_id, r.code AS role_code, r.name AS role_name, r.is_restricted AS role_is_restricted,
         a.business_unit_id, bu.name AS business_unit_name, bu.management_model,
         a.branch_id, a.department_id, d.name AS department_name,
         a.requested_by, sec.user_name(a.requested_by) AS requested_by_name, a.requested_at,
         a.decided_by, sec.user_name(a.decided_by) AS decided_by_name, a.decided_at, a.decision_note,
         a.revoked_by, sec.user_name(a.revoked_by) AS revoked_by_name, a.revoked_at
    FROM user_role_assignment a
    JOIN role r ON r.id = a.role_id
    LEFT JOIN app_user u  ON u.id = a.user_id
    LEFT JOIN business_unit bu ON bu.id = a.business_unit_id
    LEFT JOIN department d ON d.id = a.department_id`;

export function assignmentRoutes() {
  const router = Router();

  router.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `${SELECT_ASSIGNMENT}
        WHERE ($1::assignment_status IS NULL OR a.status = $1)
          AND ($2::uuid IS NULL OR a.user_id = $2)
          AND ($3::uuid IS NULL OR a.business_unit_id = $3)
        ORDER BY a.requested_at DESC LIMIT 500`,
      [q.status ?? null, q.userId ?? null, q.businessUnitId ?? null])).rows);
    res.json(rows);
  });

  // Status (active vs pending partner approval) is decided by the database trigger, not by the caller.
  router.post('/', async (req, res) => {
    const b = parse(createSchema, req.body);
    const row = await req.db(async (c) => {
      const { id } = (await c.query(
        `INSERT INTO user_role_assignment (tenant_id, user_id, role_id, business_unit_id, branch_id, department_id, requested_by)
         VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, sec.current_user_id()) RETURNING id`,
        [b.userId, b.roleId, b.businessUnitId ?? null, b.branchId ?? null, b.departmentId ?? null])).rows[0];
      return (await c.query(`${SELECT_ASSIGNMENT} WHERE a.id = $1`, [id])).rows[0];
    });
    res.status(201).json(row);
  });

  const transition = (status) => async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { note } = parse(decisionSchema, req.body ?? {});
    const row = await req.db(async (c) => {
      const updated = await c.query(
        `UPDATE user_role_assignment SET status = $2, decision_note = coalesce($3, decision_note)
          WHERE id = $1 RETURNING id`, [id, status, note ?? null]);
      if (updated.rowCount === 0) return null;
      return (await c.query(`${SELECT_ASSIGNMENT} WHERE a.id = $1`, [id])).rows[0];
    });
    if (!row) throw notFound('Assignment not found.');
    res.json(row);
  };

  router.post('/:id/approve', transition('active'));
  router.post('/:id/reject', transition('rejected'));
  router.post('/:id/revoke', transition('revoked'));

  return router;
}
