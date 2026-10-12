import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

const listQuery = z.object({
  entity: z.string().max(60).optional(),
  entityId: z.string().max(120).optional(),
  businessUnitId: z.uuid().optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditRoutes() {
  const router = Router();

  // Row-level security limits rows to units where the caller holds audit.read.
  router.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT l.id, l.at, l.action, l.entity, l.entity_id, l.business_unit_id, bu.name AS business_unit_name,
              l.user_id, sec.user_name(l.user_id) AS user_name, l.before_data, l.after_data, l.correlation_id
         FROM audit_log l
         LEFT JOIN business_unit bu ON bu.id = l.business_unit_id
        WHERE ($1::text IS NULL OR l.entity = $1)
          AND ($2::text IS NULL OR l.entity_id = $2)
          AND ($3::uuid IS NULL OR l.business_unit_id = $3)
          AND ($4::bigint IS NULL OR l.id < $4)
        ORDER BY l.id DESC LIMIT $5`,
      [q.entity ?? null, q.entityId ?? null, q.businessUnitId ?? null, q.beforeId ?? null, q.limit])).rows);
    res.json(rows);
  });

  router.get('/verify', async (req, res) => {
    const firstBrokenId = await req.db(async (c) =>
      (await c.query('SELECT sec.verify_my_tenant_audit() AS id')).rows[0].id);
    res.json({ intact: firstBrokenId === null, firstBrokenId: firstBrokenId === null ? null : Number(firstBrokenId) });
  });

  return router;
}
