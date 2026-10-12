# Architecture

## Two database roles

| Role | Used by | Row-level security |
|---|---|---|
| `giddy_owner` | migrations, seed scripts | owns the tables (not filtered) |
| `giddy_app` | every API request | **always filtered** (`NOBYPASSRLS`) |

Each request runs in one transaction that first sets `app.user_id` and `app.tenant_id`
with `set_config(..., true)` (transaction-local), see `server/src/db/context.js`.
Policies read these through `sec.current_user_id()` / `sec.current_tenant_id()`.

## Data classes and access scope

Every business table is tagged with one data class:

| Class | Meaning |
|---|---|
| `OPS` | Operations: bookings, stock, schedules |
| `FIN` | Finance: sales, folios, payments, ledger |
| `CFG` | Configuration: services, prices, resources, settings |
| `SEN` | Sensitive client data (spa intake / health) |

`user_access_scope` holds, per user and business unit, `read` or `write` for each class.
It is rebuilt by triggers whenever role assignments or units change
(`sec.rebuild_user_scope`). The rules:

- A role assigned **in a unit** grants its permissions in that unit.
- A role assigned **tenant-wide** grants its permissions in every **owner-managed** unit.
- In a **partnership** unit a tenant-wide role grants nothing — except roles with
  `partnership_visibility = 'read'` (System Owner), which get **read** on OPS/FIN/CFG and never SEN.

A business table's policies follow this template (see `business_unit_setting`):

```sql
CREATE POLICY x_read  ON x FOR SELECT USING (tenant_id = sec.current_tenant_id() AND sec.has_scope(business_unit_id, 'FIN'));
CREATE POLICY x_write ON x FOR ALL    USING (... sec.has_scope(business_unit_id, 'FIN', true))
                                      WITH CHECK (... sec.has_scope(business_unit_id, 'FIN', true));
```

## Roles

| Role | Scope | Notes |
|---|---|---|
| System Owner | tenant | full control of owner units; read-only Spa (no SEN); assigns restricted roles |
| IT Administrator | tenant | user accounts and role assignments; no business data; sees only account/role audit entries |
| Group Auditor | tenant | read-only owner units (restricted) |
| Business Partner | one partnership unit | full control of that unit; approves FIN/CFG grants there (restricted) |
| Unit Manager | unit | operations + configuration; reads finance |
| Front Desk | unit | bookings, taking payments |
| Cashier | department | point of sale |
| Storekeeper | unit | inventory documents |
| Staff | self | own schedule and tasks |

## Rules enforced in the database

- Nobody grants a role to themselves or approves a grant they requested or receive (CHECK constraints).
- A grant giving FIN or CFG access in a partnership unit starts as `pending_approval` and only
  takes effect when a partner of that unit approves it (`sec.assignment_before_insert`).
- Restricted roles (System Owner, Business Partner, Group Auditor) can only be granted or revoked
  by the System Owner. Holders of restricted roles are **protected accounts**: only the System Owner can
  reset their password, change their email, deactivate them or end their sessions.
- Accounts lock for 15 minutes after 5 failed sign-ins.
- Sessions are stored as SHA-256 hashes and are reachable only through `SECURITY DEFINER` functions.

## Audit log

`audit_log` is append-only (a trigger rejects UPDATE, DELETE and TRUNCATE, even for the table owner)
and hash-chained per tenant: each row stores the SHA-256 of the previous row's hash plus its own
content. `sec.audit_verify_chain` recomputes the chain and returns the first altered entry.
Password hashes are stripped from snapshots.

## Open decisions

- Partnership revenue share: which side the rate applies to, the revenue basis, who collects
  payments, and whether retail counts. The agreement table (stage 11) stores all four as settings.
- Department-level narrowing of access (e.g. a cashier limited to the Bar) is stored on assignments
  and will be applied to tables that carry a department, starting in stage 4.
