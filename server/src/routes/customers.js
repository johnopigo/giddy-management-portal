import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/validate.js';
import { HttpError, notFound } from '../lib/errors.js';

const emailField = z.email().max(254).nullish().or(z.literal('').transform(() => null));
const phoneField = z.string().trim().max(30).regex(/^[+0-9 ()-]*$/, 'Use digits, spaces, +, -, ( or ).').nullish()
  .transform((v) => v || null);
const createSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  phone: phoneField,
  email: emailField,
  dateOfBirth: z.iso.date().nullish(),
}).refine((v) => v.phone || v.email, { message: 'Enter a phone number or an email address.', path: ['phone'] });
const patchSchema = z.object({
  fullName: z.string().trim().min(2).max(160).optional(),
  phone: phoneField.optional(),
  email: emailField.optional(),
  dateOfBirth: z.iso.date().nullish(),
  rowVersion: z.int(),
});
const profileSchema = z.object({
  notes: z.string().max(4000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  marketingOptIn: z.boolean().default(false),
});
const searchQuery = z.object({ q: z.string().trim().max(80).optional() });
const profileParams = z.object({ id: z.uuid(), businessUnitId: z.uuid() });

const CUSTOMER_COLUMNS = 'id, full_name, phone, email, date_of_birth, created_at, row_version';

export function customerRoutes() {
  const router = Router();

  // Search by name, phone (any formatting) or email.
  router.get('/', async (req, res) => {
    const { q } = parse(searchQuery, req.query);
    const digits = q?.replace(/\D/g, '').slice(-10) || null;
    const rows = await req.db(async (c) => (await c.query(
      `SELECT ${CUSTOMER_COLUMNS} FROM customer
        WHERE $1::text IS NULL
           OR lower(full_name) LIKE '%' || lower($1) || '%'
           OR email = $1::citext
           OR ($2::text IS NOT NULL AND length($2) >= 4 AND phone_normalized LIKE '%' || $2 || '%')
        ORDER BY full_name LIMIT 50`, [q || null, digits])).rows);
    res.json(rows);
  });

  router.post('/', async (req, res) => {
    const b = parse(createSchema, req.body);
    const row = await req.db(async (c) => {
      const digits = b.phone?.replace(/\D/g, '').slice(-10) || null;
      const existing = (await c.query(
        `SELECT ${CUSTOMER_COLUMNS} FROM customer
          WHERE ($1::text IS NOT NULL AND phone_normalized = $1) OR ($2::citext IS NOT NULL AND email = $2::citext)
          LIMIT 1`, [digits, b.email ?? null])).rows[0];
      if (existing) {
        throw new HttpError(409, 'A customer with this phone number or email already exists.', { existing });
      }
      return (await c.query(
        `INSERT INTO customer (tenant_id, full_name, phone, email, date_of_birth)
         VALUES (sec.current_tenant_id(), $1, $2, $3, $4) RETURNING ${CUSTOMER_COLUMNS}`,
        [b.fullName, b.phone ?? null, b.email ?? null, b.dateOfBirth ?? null])).rows[0];
    });
    res.status(201).json(row);
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const data = await req.db(async (c) => {
      const customer = (await c.query(`SELECT ${CUSTOMER_COLUMNS} FROM customer WHERE id = $1`, [id])).rows[0];
      if (!customer) return null;
      // Only the profiles of units the caller works in are returned (row-level security).
      const profiles = (await c.query(
        `SELECT p.business_unit_id, bu.name AS business_unit_name, p.notes, p.tags, p.marketing_opt_in,
                p.updated_at, p.row_version, sec.has_scope(p.business_unit_id, 'OPS', true) AS can_edit
           FROM customer_unit_profile p JOIN business_unit bu ON bu.id = p.business_unit_id
          WHERE p.customer_id = $1 ORDER BY bu.name`, [id])).rows;
      return { ...customer, profiles };
    });
    if (!data) throw notFound('Customer not found.');
    res.json(data);
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const b = parse(patchSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `UPDATE customer SET
         full_name = coalesce($2, full_name),
         phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
         email = CASE WHEN $5::boolean THEN $6::citext ELSE email END,
         date_of_birth = CASE WHEN $7::boolean THEN $8::date ELSE date_of_birth END
       WHERE id = $1 AND row_version = $9 RETURNING ${CUSTOMER_COLUMNS}`,
      [id, b.fullName ?? null, b.phone !== undefined, b.phone ?? null, b.email !== undefined, b.email ?? null,
       b.dateOfBirth !== undefined, b.dateOfBirth ?? null, b.rowVersion])).rows[0]);
    if (!row) throw notFound('Customer not found, or it was changed by someone else.');
    res.json(row);
  });

  router.put('/:id/profiles/:businessUnitId', async (req, res) => {
    const { id, businessUnitId } = parse(profileParams, req.params);
    const b = parse(profileSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO customer_unit_profile (tenant_id, business_unit_id, customer_id, notes, tags, marketing_opt_in)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5)
       ON CONFLICT (business_unit_id, customer_id) DO UPDATE
         SET notes = EXCLUDED.notes, tags = EXCLUDED.tags, marketing_opt_in = EXCLUDED.marketing_opt_in, updated_at = now()
       RETURNING business_unit_id, notes, tags, marketing_opt_in, updated_at, row_version`,
      [businessUnitId, id, b.notes, b.tags, b.marketingOptIn])).rows[0]);
    res.json(row);
  });

  return router;
}
