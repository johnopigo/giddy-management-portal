import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const supplierFields = {
  name: z.string().trim().min(2).max(160),
  contactName: z.string().trim().max(120).nullish(),
  phone: z.string().trim().max(40).nullish(),
  email: z.email().max(254).nullish().or(z.literal('').transform(() => null)),
  taxId: z.string().trim().max(40).nullish(),
  address: z.string().trim().max(300).nullish(),
};
const createSchema = z.object({ ...supplierFields, ownerBusinessUnitId: z.uuid().nullish() });
const patchSchema = z.object({
  ...Object.fromEntries(Object.entries(supplierFields).map(([k, v]) => [k, v.optional()])),
  isActive: z.boolean().optional(),
  rowVersion: z.int(),
});
const accountSchema = z.object({
  accountNumber: z.string().trim().max(60).nullish(),
  paymentTermsDays: z.int().min(0).max(365).default(0),
  notes: z.string().max(500).nullish(),
  isActive: z.boolean().default(true),
});
const listQuery = z.object({ businessUnitId: z.uuid().optional() });
const accountParams = z.object({ id: z.uuid(), businessUnitId: z.uuid() });

export function supplierRoutes() {
  const router = Router();

  // Supplier master records are shared; a unit's account and terms appear only with FIN read there.
  router.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT s.id, s.name, s.contact_name, s.phone, s.email, s.tax_id, s.address, s.is_active, s.row_version,
              s.owner_business_unit_id, ob.name AS owner_business_unit_name,
              sec.can_manage_master(s.owner_business_unit_id) AS can_manage,
              bus.account_number, bus.payment_terms_days, bus.notes AS account_notes, bus.is_active AS account_active
         FROM supplier s
         LEFT JOIN business_unit ob ON ob.id = s.owner_business_unit_id
         LEFT JOIN business_unit_supplier bus ON bus.supplier_id = s.id AND bus.business_unit_id = $1
        ORDER BY s.name`, [q.businessUnitId ?? null])).rows);
    res.json(rows);
  });

  router.post('/', async (req, res) => {
    const b = parse(createSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO supplier (tenant_id, owner_business_unit_id, name, contact_name, phone, email, tax_id, address)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [b.ownerBusinessUnitId ?? null, b.name, b.contactName ?? null, b.phone ?? null, b.email ?? null,
       b.taxId ?? null, b.address ?? null])).rows[0]);
    res.status(201).json(row);
  });

  router.patch('/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const b = parse(patchSchema, req.body);
    const set = (k) => (b[k] === undefined ? null : b[k]);
    const row = await req.db(async (c) => (await c.query(
      `UPDATE supplier SET
         name = coalesce($2, name),
         contact_name = CASE WHEN $3::boolean THEN $4 ELSE contact_name END,
         phone        = CASE WHEN $5::boolean THEN $6 ELSE phone END,
         email        = CASE WHEN $7::boolean THEN $8::citext ELSE email END,
         tax_id       = CASE WHEN $9::boolean THEN $10 ELSE tax_id END,
         address      = CASE WHEN $11::boolean THEN $12 ELSE address END,
         is_active    = coalesce($13, is_active)
       WHERE id = $1 AND row_version = $14 RETURNING *`,
      [id, set('name'),
       b.contactName !== undefined, set('contactName'), b.phone !== undefined, set('phone'),
       b.email !== undefined, set('email'), b.taxId !== undefined, set('taxId'),
       b.address !== undefined, set('address'), set('isActive'), b.rowVersion])).rows[0]);
    if (!row) throw notFound('Supplier not found, you cannot change it, or it was changed by someone else.');
    res.json(row);
  });

  router.put('/:id/units/:businessUnitId', async (req, res) => {
    const { id, businessUnitId } = parse(accountParams, req.params);
    const b = parse(accountSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO business_unit_supplier (tenant_id, business_unit_id, supplier_id, account_number, payment_terms_days, notes, is_active)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_unit_id, supplier_id) DO UPDATE
         SET account_number = EXCLUDED.account_number, payment_terms_days = EXCLUDED.payment_terms_days,
             notes = EXCLUDED.notes, is_active = EXCLUDED.is_active
       RETURNING *`,
      [businessUnitId, id, b.accountNumber ?? null, b.paymentTermsDays, b.notes ?? null, b.isActive])).rows[0]);
    res.json(row);
  });

  return router;
}
