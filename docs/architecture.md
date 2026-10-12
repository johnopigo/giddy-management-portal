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

## Catalogue and suppliers

- `item` and `supplier` are **shared master records**: every user in the tenant can see them.
  Each has an owner — the group (`owner_business_unit_id` NULL, managed by holders of `tenant.settings`)
  or one unit (managed by that unit's CFG writers). So the Spa Partner can maintain Spa products,
  and nobody else can rename them.
- A unit can only use **group items and its own items** — never another unit's
  (`inv.business_unit_item_check_owner`). The Catalogue lists only those items for the selected unit.
- What a unit does with a shared record is private to the unit: `business_unit_item` (selling price,
  reorder level — CFG) and `business_unit_supplier` (account number, payment terms — FIN).
- Batch and expiry tracking are fixed when an item is created; changing them later would invalidate
  the stock ledger.

## Inventory

Locations form a strict hierarchy per unit: **Branch store → Department store → Staff holding**
(checked by constraints and `inv.location_check_parent`).

Quantities change **only** through `inv.post_movement()`; the API role has no write access to
`stock_balance`, `item_batch` or `stock_movement`.

| Movement | Direction | Needs |
|---|---|---|
| `opening_balance` | in | CFG write, unit cost |
| `adjustment_in` / `adjustment_out` | in / out | CFG write, a reason |
| `transfer` | between two locations of the same unit | OPS write |
| `issue` | out | OPS write |
| `wastage` | out | OPS write, reason: damage / expiry / theft / spillage / other |

- `stock_movement` is the ledger: append-only (UPDATE/DELETE/TRUNCATE rejected) and every row is also
  written to the hash-chained audit log.
- `stock_balance.qty_on_hand` has `CHECK (>= 0)` and posting locks the balance rows it draws from, so
  concurrent sales cannot oversell (tested with 25 simultaneous requests for 10 units).
- Batch-tracked items: incoming stock needs a batch number (and expiry if expiry-tracked). Outgoing stock
  without an explicit batch is drawn **First-Expire-First-Out** and never from expired batches; an explicit
  batch can be chosen to write off expired stock. Rows are locked in expiry order, so concurrent postings
  cannot deadlock.
- Unit cost on movements is financial: the API returns it only to users with FIN read in the unit.
- Internally every quantity change goes through `inv.apply_movement` (no permission checks, not callable
  by the API role). `inv.post_movement` (manual movements) and the document workflows below are the only
  callers, and each checks permissions first.

### Costing

Moving weighted average per unit and item (`item_cost`, FIN data). An incoming movement with a cost
(opening balance, purchase receipt, transfer in) re-averages:
`new avg = (on hand × avg + qty × cost) / (on hand + qty)`. Every other movement is valued at the current
average, so stock value = on hand × average.

## Purchasing

`draft → submitted → approved → partially_received → received`, or `closed` (short) / `cancelled`.
All changes go through `inv.po_*` functions; the API role can only read the tables.

| Step | Who |
|---|---|
| Draft, edit draft, submit | OPS write + FIN read (storekeeper, manager) |
| Approve, send back (needs a reason), close short, cancel | CFG write + FIN read (manager, owner, partner) |
| Receive goods | OPS write |

- **Segregation of duties:** you cannot approve a purchase order you submitted unless you also hold
  FIN write (the Owner, or the Partner in the Spa).
- Receiving checks the outstanding quantity per line, needs batch/expiry for tracked items, posts a
  `receipt` movement at the PO price and re-averages cost. Goods receipts are append-only.
- Numbers: `PO-<UNIT>-000001`, `GRN-…`, `TRF-…`, `REQ-…` (per-unit counters).
- Reorder suggestions: items at or below their reorder level, suggested quantity
  `max(reorder qty, 2 × reorder level − on hand)`, with the last price and supplier.

## Transfers between units

The sending unit dispatches from one of its stores (`inter_unit_out` at average cost); the stock is
in transit. The receiving unit accepts it into a store of its choice (`inter_unit_in` at the same cost,
batches and expiry dates carried over) or refuses it with a reason, after which the sender puts it back.
Only group items can move (unit-owned items cannot be enabled elsewhere), and the receiving unit must
stock the item. Each side sees only its own store names.

## Item requests

Anyone working in a unit (OPS read) can request items from a store to a location → a manager
(CFG write) approves, optionally reducing quantities, or rejects with a reason → someone with OPS write
issues them (an internal transfer). Requesters cannot approve their own requests unless they hold FIN write.

## Notifications

In-app, created by the database functions: purchase order submitted / approved / sent back, low stock
(when a movement takes a unit's total to or below the reorder level), transfer incoming / received /
refused, item request submitted / decided / issued. Recipients are the unit's managers (CFG write) or the
person involved. The sidebar bell refreshes every minute.

## Customers

- `customer` holds the shared identity (name, phone, email, date of birth), visible to anyone with
  operational access in some unit. Phone numbers are matched on their last 10 digits, so
  `+234 803…`, `234-803…` and `0803…` are the same customer.
- `customer_unit_profile` holds each unit's notes, tags and marketing consent, visible only to that unit
  (and read-only to the Owner for the Spa). Spa health/intake data will live in a separate SEN table (stage 10).

## Books (finance core)

Every unit keeps its own double-entry ledger (`fin` schema).

- **Chart of accounts**, created automatically for each unit: 1000 Cash, 1010 Card/POS clearing, 1020 Bank,
  1150 Due from other units, 1200 Inventory, 2000 Accounts payable, 2100 VAT payable, 2200 Due to other units,
  3000 Opening balance equity, 4000 Sales revenue, 4100 Service charge income, 5000 Cost of goods sold,
  5100 Stock write-offs, 5200 Stock adjustments, 5300 Stock used internally.
- `journal_entry` / `journal_line` are append-only. A deferred constraint trigger refuses to commit any
  entry whose debits and credits differ, so an unbalanced entry cannot exist.
- **Monthly periods** are created on first posting. The owner of the unit's books (FIN write + CFG write:
  the Owner, or the Partner for the Spa) closes a month after it ends, in order; closed months refuse postings
  and cannot be reopened.
- **Automatic postings** from every stock movement (trigger on `stock_movement`):

  | Movement | Debit | Credit |
  |---|---|---|
  | opening balance | 1200 Inventory | 3000 Opening equity |
  | purchase receipt | 1200 Inventory | 2000 Accounts payable |
  | adjustment in / out | 1200 / 5200 | 5200 / 1200 |
  | wastage | 5100 Write-offs | 1200 |
  | issue (internal use) | 5300 Used internally | 1200 |
  | sale / sale void | 5000 COGS / 1200 | 1200 / 5000 |
  | sent to another unit | 1150 Due from (that unit) | 1200 |
  | received from another unit | 1200 | 2200 Due to (that unit) |
  | refused transfer put back | 1200 | 1150 |

## Point of sale

- `pos.checkout` takes the department, the store it sells from, lines (item + quantity, fractional allowed)
  and payments (cash / card / transfer). **Prices always come from the unit's price list**; the till cannot
  override them. Items without a price are not on the till.
- Totals: subtotal − discount = net; service charge (`charges.service_pct`) on net; VAT (`tax.vat_pct`) on
  net + service charge. The web till mirrors this in `web/src/lib/pricing.js` for display; the server decides.
- Discounts above `pos.max_discount_pct` (default 10%) need configuration write (a manager-level seller).
- Payments must cover the total; card and transfer cannot exceed it; change is given from cash only.
- **Department restriction:** selling needs `fin.write` through an assignment that covers the department —
  a cashier assigned to the Bar cannot sell in the Kitchen (`sec.can_sell`).
- The sale posts: Dr cash (net of change) / card clearing / bank, Cr revenue (net of discount), Cr service
  charge income, Cr VAT payable; and the stock leaves at average cost (Dr COGS, Cr Inventory).
- **Voids:** only the owner of the unit's books, with a reason. Stock returns to the same batches at the
  original cost and the sale's journal entry is reversed line for line. Tickets, lines and payments are
  otherwise immutable (a ticket can change once: completed → voided).
- **Sales history:** sellers (finance write without configuration write: cashiers, front desk) see their own
  tickets; managers, the owner and read-only viewers see all.

## Open decisions

- Partnership revenue share: which side the rate applies to, the revenue basis, who collects
  payments, and whether retail counts. The agreement table (stage 11) stores all four as settings.
- Department-level narrowing is enforced at the till (stage 4). Reading data is still unit-wide.
- Supplier payments (settling 2000 Accounts payable) and settling balances between units (1150 / 2200)
  are not built yet.
