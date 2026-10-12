import { describe, it, expect } from 'vitest';
import { hasTenantPermission, hasUnitPermission, hasAnyUnitPermission, unitAccess } from './permissions.js';

const me = {
  permissions: [
    { code: 'users.manage', business_unit_id: null },
    { code: 'grants.approve', business_unit_id: 'spa' },
  ],
  scope: [{ business_unit_id: 'spa', access: { OPS: 'read', FIN: 'read' } }],
};

describe('permission helpers', () => {
  it('distinguishes tenant-wide from unit permissions', () => {
    expect(hasTenantPermission(me, 'users.manage')).toBe(true);
    expect(hasTenantPermission(me, 'grants.approve')).toBe(false);
    expect(hasUnitPermission(me, 'grants.approve', 'spa')).toBe(true);
    expect(hasUnitPermission(me, 'grants.approve', 'fnb')).toBe(false);
    expect(hasAnyUnitPermission(me, 'grants.approve')).toBe(true);
  });

  it('reads data-class access per unit', () => {
    expect(unitAccess(me, 'spa', 'FIN')).toBe('read');
    expect(unitAccess(me, 'spa', 'CFG')).toBeNull();
    expect(unitAccess(me, 'fnb', 'OPS')).toBeNull();
    expect(unitAccess(null, 'spa', 'OPS')).toBeNull();
  });
});
