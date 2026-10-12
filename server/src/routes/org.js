import { Router } from 'express';
import { z } from 'zod';
import { parse, uuidParam } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';

const businessUnitSchema = z.object({
  legalEntityId: z.uuid(),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'Use 2–20 capitals, digits or underscores.'),
  name: z.string().trim().min(2).max(120),
  unitType: z.enum(['apartments', 'food_beverage', 'content_studio', 'spa']),
  managementModel: z.enum(['owner', 'partnership']),
  currencyCode: z.string().length(3).default('NGN'),
  timeZone: z.string().default('Africa/Lagos'),
});
const businessUnitPatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
  rowVersion: z.int(),
});
const legalEntitySchema = z.object({ name: z.string().trim().min(2).max(160), taxId: z.string().max(40).optional() });
const branchSchema = z.object({ name: z.string().trim().min(2).max(120), address: z.string().max(300).optional() });
const departmentSchema = z.object({
  businessUnitId: z.uuid(),
  branchId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  kind: z.string().trim().min(2).max(40).default('general'),
});
const settingSchema = z.object({ value: z.json() });
const settingParams = z.object({ id: z.uuid(), key: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/) });

export function orgRoutes() {
  const router = Router();

  router.get('/', async (req, res) => {
    const data = await req.db(async (c) => ({
      legalEntities: (await c.query('SELECT id, name, tax_id FROM legal_entity ORDER BY name')).rows,
      businessUnits: (await c.query(
        `SELECT id, legal_entity_id, code, name, unit_type, management_model, currency_code, time_zone,
                is_active, row_version FROM business_unit ORDER BY name`)).rows,
      branches: (await c.query('SELECT id, name, address, is_active FROM branch ORDER BY name')).rows,
      departments: (await c.query(
        'SELECT id, business_unit_id, branch_id, name, kind, is_active FROM department ORDER BY name')).rows,
    }));
    res.json(data);
  });

  router.post('/legal-entities', async (req, res) => {
    const body = parse(legalEntitySchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO legal_entity (tenant_id, name, tax_id) VALUES (sec.current_tenant_id(), $1, $2) RETURNING *`,
      [body.name, body.taxId ?? null])).rows[0]);
    res.status(201).json(row);
  });

  router.post('/business-units', async (req, res) => {
    const b = parse(businessUnitSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO business_unit (tenant_id, legal_entity_id, code, name, unit_type, management_model, currency_code, time_zone)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [b.legalEntityId, b.code, b.name, b.unitType, b.managementModel, b.currencyCode, b.timeZone])).rows[0]);
    res.status(201).json(row);
  });

  router.patch('/business-units/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const b = parse(businessUnitPatch, req.body);
    const row = await req.db(async (c) => (await c.query(
      `UPDATE business_unit SET name = coalesce($2, name), is_active = coalesce($3, is_active)
        WHERE id = $1 AND row_version = $4 RETURNING *`,
      [id, b.name ?? null, b.isActive ?? null, b.rowVersion])).rows[0]);
    if (!row) throw notFound('Business unit not found, or it was changed by someone else.');
    res.json(row);
  });

  router.post('/branches', async (req, res) => {
    const b = parse(branchSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO branch (tenant_id, name, address) VALUES (sec.current_tenant_id(), $1, $2) RETURNING *`,
      [b.name, b.address ?? null])).rows[0]);
    res.status(201).json(row);
  });

  router.post('/departments', async (req, res) => {
    const b = parse(departmentSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO department (tenant_id, business_unit_id, branch_id, name, kind)
       VALUES (sec.current_tenant_id(), $1, $2, $3, $4) RETURNING *`,
      [b.businessUnitId, b.branchId, b.name, b.kind])).rows[0]);
    res.status(201).json(row);
  });

  // Unit settings — readable with CFG read, writable with CFG write (enforced by row-level security).
  router.get('/business-units/:id/settings', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const rows = await req.db(async (c) => (await c.query(
      `SELECT key, value, updated_at FROM business_unit_setting WHERE business_unit_id = $1 ORDER BY key`,
      [id])).rows);
    res.json(rows);
  });

  router.put('/business-units/:id/settings/:key', async (req, res) => {
    const { id, key } = parse(settingParams, req.params);
    const { value } = parse(settingSchema, req.body);
    const row = await req.db(async (c) => (await c.query(
      `INSERT INTO business_unit_setting (tenant_id, business_unit_id, key, value)
       VALUES (sec.current_tenant_id(), $1, $2, $3)
       ON CONFLICT (business_unit_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       RETURNING key, value, updated_at`,
      [id, key, JSON.stringify(value)])).rows[0]);
    res.json(row);
  });

  return router;
}
