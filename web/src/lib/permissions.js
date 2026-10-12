/**
 * Helpers over the /api/me payload. These only decide what to SHOW; every rule is
 * enforced again by the API and by row-level security in the database.
 */
export function hasTenantPermission(me, code) {
  return Boolean(me?.permissions?.some((p) => p.code === code && p.business_unit_id === null));
}

export function hasUnitPermission(me, code, businessUnitId) {
  return Boolean(me?.permissions?.some((p) => p.code === code && p.business_unit_id === businessUnitId));
}

export function hasAnyUnitPermission(me, code) {
  return Boolean(me?.permissions?.some((p) => p.code === code));
}

export function unitAccess(me, businessUnitId, dataClass) {
  return me?.scope?.find((s) => s.business_unit_id === businessUnitId)?.access?.[dataClass] ?? null;
}

export const DATA_CLASS_LABELS = {
  OPS: 'Operations',
  FIN: 'Finance',
  CFG: 'Configuration',
  SEN: 'Sensitive client data',
};

export const UNIT_TYPE_LABELS = {
  apartments: 'Luxury Apartments',
  food_beverage: 'Food & Beverage',
  content_studio: 'Content Studio',
  spa: 'Spa',
};
