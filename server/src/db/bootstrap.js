import { hashPassword } from '../auth/password.js';

/**
 * Creates a tenant with its legal entities, business units, a branch, departments and the
 * first three users. Runs on the OWNER connection: it is the only path that may create
 * role assignments without a requesting user (requested_by NULL).
 *
 * @param {import('pg').Client} c  owner connection, inside a transaction
 */
export async function bootstrapTenant(c, { tenantName, users }) {
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];

  const tenant = await one('INSERT INTO tenant (name) VALUES ($1) RETURNING id', [tenantName]);
  const ownerEntity = await one(
    'INSERT INTO legal_entity (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenant.id, tenantName]);
  const partnerEntity = await one(
    'INSERT INTO legal_entity (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenant.id, 'Spa Partner (to be named)']);
  const branch = await one(
    'INSERT INTO branch (tenant_id, name) VALUES ($1, $2) RETURNING id', [tenant.id, 'Main Site']);

  const unitDefs = [
    { code: 'APARTMENTS', name: 'Luxury Apartments', type: 'apartments', model: 'owner', entity: ownerEntity.id,
      departments: [['Front Desk', 'front_desk'], ['Housekeeping', 'housekeeping']] },
    { code: 'FNB', name: 'Food & Beverage', type: 'food_beverage', model: 'owner', entity: ownerEntity.id,
      departments: [['Kitchen', 'kitchen'], ['Bar', 'bar'], ['Restaurant', 'restaurant']] },
    { code: 'STUDIO', name: 'Content Studio', type: 'content_studio', model: 'owner', entity: ownerEntity.id,
      departments: [['Booths', 'booths'], ['Studio Reception', 'reception']] },
    { code: 'SPA', name: 'Spa', type: 'spa', model: 'partnership', entity: partnerEntity.id,
      departments: [['Treatment Rooms', 'treatment'], ['Spa Reception', 'reception']] },
  ];

  const units = {};
  for (const u of unitDefs) {
    const bu = await one(
      `INSERT INTO business_unit (tenant_id, legal_entity_id, code, name, unit_type, management_model)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenant.id, u.entity, u.code, u.name, u.type, u.model]);
    units[u.code] = bu.id;
    for (const [name, kind] of u.departments) {
      await c.query(
        `INSERT INTO department (tenant_id, business_unit_id, branch_id, name, kind) VALUES ($1, $2, $3, $4, $5)`,
        [tenant.id, bu.id, branch.id, name, kind]);
    }
    for (const [key, value] of [['tax.vat_pct', 7.5], ['charges.service_pct', 10]]) {
      await c.query(
        `INSERT INTO business_unit_setting (tenant_id, business_unit_id, key, value) VALUES ($1, $2, $3, $4)`,
        [tenant.id, bu.id, key, JSON.stringify(value)]);
    }
  }

  const roleId = async (code) => (await one('SELECT id FROM role WHERE tenant_id IS NULL AND code = $1', [code])).id;
  const createdUsers = {};
  for (const u of users) {
    const row = await one(
      `INSERT INTO app_user (tenant_id, email, full_name, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tenant.id, u.email, u.fullName, await hashPassword(u.password), u.mustChangePassword ?? true]);
    createdUsers[u.key] = row.id;
    await c.query(
      `INSERT INTO user_role_assignment (tenant_id, user_id, role_id, business_unit_id, requested_by)
       VALUES ($1, $2, $3, $4, NULL)`,
      [tenant.id, row.id, await roleId(u.role), u.unit ? units[u.unit] : null]);
  }

  return { tenantId: tenant.id, branchId: branch.id, units, users: createdUsers };
}
