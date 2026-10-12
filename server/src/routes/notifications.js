import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/validate.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function notificationRoutes() {
  const router = Router();

  router.get('/', async (req, res) => {
    const data = await req.db(async (c) => ({
      unread: (await c.query('SELECT count(*)::int AS n FROM notification WHERE read_at IS NULL')).rows[0].n,
      items: (await c.query(
        `SELECT n.id::int AS id, n.kind, n.title, n.body, n.link, n.created_at, n.read_at, bu.name AS business_unit_name
           FROM notification n LEFT JOIN business_unit bu ON bu.id = n.business_unit_id
          ORDER BY n.id DESC LIMIT 50`)).rows,
    }));
    res.json(data);
  });

  router.post('/:id/read', async (req, res) => {
    const { id } = parse(idParam, req.params);
    await req.db((c) => c.query('UPDATE notification SET read_at = now() WHERE id = $1 AND read_at IS NULL', [id]));
    res.status(204).end();
  });

  router.post('/read-all', async (req, res) => {
    await req.db((c) => c.query('UPDATE notification SET read_at = now() WHERE read_at IS NULL'));
    res.status(204).end();
  });

  return router;
}
