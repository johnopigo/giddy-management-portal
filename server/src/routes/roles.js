import { Router } from 'express';

export function roleRoutes() {
  const router = Router();
  router.get('/', async (req, res) => {
    const rows = await req.db(async (c) => (await c.query(
      `SELECT r.id, r.code, r.name, r.description, r.scope_level, r.partnership_visibility,
              r.is_restricted, r.partnership_only,
              coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code)
                       FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
         FROM role r LEFT JOIN role_permission rp ON rp.role_id = r.id
        GROUP BY r.id ORDER BY r.name`)).rows);
    res.json(rows);
  });
  return router;
}
