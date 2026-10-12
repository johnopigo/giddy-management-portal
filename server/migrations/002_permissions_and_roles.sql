-- =====================================================================
-- 002 Built-in permissions and system roles
-- =====================================================================

INSERT INTO permission (code, description, data_class, access, is_read_only) VALUES
  ('ops.read',  'Read operational records (bookings, stock, schedules)',          'OPS', 'read',  false),
  ('ops.write', 'Create and change operational records',                          'OPS', 'write', false),
  ('fin.read',  'Read financial records (sales, folios, payments, ledger)',       'FIN', 'read',  false),
  ('fin.write', 'Create financial records (take payments, post sales)',           'FIN', 'write', false),
  ('cfg.read',  'Read unit configuration (services, prices, resources)',          'CFG', 'read',  false),
  ('cfg.write', 'Change unit configuration',                                      'CFG', 'write', false),
  ('sen.read',  'Read sensitive client data (spa intake / health information)',   'SEN', 'read',  false),
  ('sen.write', 'Record sensitive client data',                                   'SEN', 'write', false),
  ('tenant.settings',          'Manage business units, branches and legal entities', NULL, NULL, false),
  ('users.read',               'See the user directory and role assignments',        NULL, NULL, true),
  ('users.manage',             'Create, update, deactivate users; reset passwords',  NULL, NULL, false),
  ('roles.assign',             'Assign and revoke non-restricted roles',             NULL, NULL, false),
  ('roles.assign_restricted',  'Assign restricted roles (System Owner, Partner)',    NULL, NULL, false),
  ('grants.approve',           'Approve finance/config grants in a partnership unit', NULL, NULL, false),
  ('audit.read',               'Read the audit log',                                 NULL, NULL, true),
  ('audit.read_security',      'Read audit entries for user and role changes only',  NULL, NULL, true);

WITH roles (code, name, description, scope, visibility, restricted, partnership_only, perms) AS (VALUES
  ('SYSTEM_OWNER', 'System Owner',
   'Full control of owner-managed units; read-only view of partnership units.',
   'tenant'::scope_level, 'read'::partnership_visibility, true, false,
   ARRAY['ops.write','ops.read','fin.write','fin.read','cfg.write','cfg.read','sen.write','sen.read',
         'tenant.settings','users.read','users.manage','roles.assign','roles.assign_restricted','audit.read']),
  ('IT_ADMIN', 'IT Administrator',
   'Manages user accounts and role assignments in every unit. No access to business data.',
   'tenant', 'none', false, false,
   ARRAY['users.read','users.manage','roles.assign','audit.read_security']),
  ('GROUP_AUDITOR', 'Group Auditor',
   'Read-only access to owner-managed units.',
   'tenant', 'none', true, false,
   ARRAY['ops.read','fin.read','cfg.read','audit.read']),
  ('BU_PARTNER', 'Business Partner',
   'Full operational and financial control of one partnership-managed unit; approves grants there.',
   'business_unit', 'none', true, true,
   ARRAY['ops.write','ops.read','fin.write','fin.read','cfg.write','cfg.read','sen.write','sen.read',
         'grants.approve','audit.read']),
  ('UNIT_MANAGER', 'Unit Manager',
   'Runs one business unit: operations and configuration; reads finance.',
   'business_unit', 'none', false, false,
   ARRAY['ops.write','ops.read','fin.read','cfg.write','cfg.read','sen.write','sen.read']),
  ('FRONT_DESK', 'Front Desk / Receptionist',
   'Bookings, check-in/out and taking payments.',
   'business_unit', 'none', false, false,
   ARRAY['ops.write','ops.read','fin.write','fin.read','cfg.read','sen.read']),
  ('CASHIER', 'Seller / Cashier',
   'Point-of-sale checkout in one department.',
   'department', 'none', false, false,
   ARRAY['ops.write','ops.read','fin.write','cfg.read']),
  ('STOREKEEPER', 'Storekeeper',
   'Inventory documents: receiving, transfers, counts.',
   'business_unit', 'none', false, false,
   ARRAY['ops.write','ops.read','fin.read','cfg.read']),
  ('STAFF', 'Staff (Therapist / Attendant / Employee)',
   'Own schedule, own assigned items and tasks.',
   'self', 'none', false, false,
   ARRAY['ops.read'])
), inserted AS (
  INSERT INTO role (tenant_id, code, name, description, scope_level, partnership_visibility, is_restricted, partnership_only)
  SELECT NULL, code, name, description, scope, visibility, restricted, partnership_only FROM roles
  RETURNING id, code
)
INSERT INTO role_permission (role_id, permission_code)
SELECT i.id, unnest(r.perms) FROM inserted i JOIN roles r ON r.code = i.code;
