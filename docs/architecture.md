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

## Recipes and production

- A **recipe** belongs to one unit and one output item: `yield_qty` units of output need the listed
  ingredient quantities (each in its own base unit). Managers (CFG write) maintain recipes; the kitchen
  (OPS read) can read them. Cost per unit (at current average cost) and margin against the selling price
  are shown only to finance readers.
- **At the till** (`pos.stock_for_sale`): a stock item is sold from the till's store; a non-stock item with
  an active recipe deducts its ingredients (qty × sold ÷ yield) from the till's store; a non-stock item without
  a recipe (a service, corkage) deducts nothing. A sale fails cleanly if any ingredient is short, and a void
  returns every ingredient.
- **Production orders** (`PRD-<UNIT>-…`, stock outputs only): `planned → completed | cancelled`.
  Completing consumes the ingredients actually used (default: planned) from one store
  (`production_consume`: Dr 1250 Production in progress, Cr 1200) and puts the actual output into another
  (`production_output`: Dr 1200, Cr 1250) costed at total input ÷ actual output. Anything left in 1250 —
  a failed batch or rounding — is written off to 5100 at once, so 1250 always returns to zero.
  Yield variance = (actual − planned) ÷ planned.
- Movement → account mapping is now a table (`fin.movement_account`), so new movement types add a row.

## Luxury Apartments (front desk)

- **Setup** (CFG write): room types (code, base nightly rate, occupancy, amenities), rooms (number, floor,
  type) and rate plans (a different nightly rate for a date range, e.g. December). The nightly price is the
  newest rate plan covering that night, else the type's base rate.
- **Bookings** (`apt.book`): one reservation can hold several rooms. A room is either chosen or assigned
  automatically (first free room of the type). Every booked night is a row in `room_night`, whose primary key
  is (room, date), so two bookings can never hold the same room on the same night; concurrent attempts
  get a clean 409 "room 201 is already booked on …" (custom SQLSTATE `GD409`). Arrival can't be in the past;
  stays over 90 nights are refused (long lets are a separate agreement).
- **Statuses:** `confirmed → checked_in → checked_out`, or `confirmed → cancelled | no_show`
  (cancelling needs a reason; no-show only after the arrival date; either releases the nights, and the bill must be
  settled first — refund the deposit or post a fee). Stays can be extended if the extra nights are free.
- **Check-in** only on or after the arrival date and only into rooms that are not under maintenance,
  out of order or being cleaned. The room becomes *occupied*.
- **Guest bill** (`folio`, `FOL-<UNIT>-…`), one per reservation, with immutable entries:
  - *Night audit* (`apt.post_room_charges`, "Post room charges") charges every in-house night up to today with
    service charge and VAT — Dr 1100 Guest ledger, Cr 4200 Room revenue / 4100 / 2100. It is idempotent.
  - *Payments and deposits* (cash, card, transfer): Dr 1000/1010/1020, Cr 1100. *Refunds* only of a credit balance.
  - *Extra charges* (laundry, airport pick-up) to 4000; *adjustments* (manager only, not above the balance due)
    reduce room revenue.
- **Charge to room from any till.** A cashier in any unit can take payment method *Charge to room* and pick an
  in-house guest (`/api/apartments/in-house` lists only room numbers and names). The sale posts in the
  selling unit's books as Dr 1150 Due from Apartments; the Apartments books post Dr 1100 Guest ledger,
  Cr 2200 Due to F&B, and the bill shows the line as "From another unit". Voiding the sale reverses the bill line
  while the guest is still in house.
- **Check-out** charges any nights not yet charged, releases unused nights (early departure), and requires a zero
  balance. The bill closes, the room goes to *cleaning* and a cleaning task is created.
- **Housekeeping:** tasks (clean, inspect, maintenance) per room. Only the assigned housekeeper or the front desk
  can update a task; finishing a clean makes the room available. Setting a room to maintenance creates a task too.

## Booking engine (Spa and Content Studio)

One engine (`bk` schema) serves both kinds of booking:

- **Service-based** (`mode = 'service'`): a treatment of fixed length, e.g. a 60-minute massage.
- **Slot-based** (`mode = 'slot'`): a resource hired in consecutive slots, e.g. a booth for 1–4 hours at a price per slot.

**Setup** (managers, CFG write; in the Spa that is the partner):
- *Resources* are what gets booked: staff, rooms, booths and equipment. Each has weekly hours in the unit's time zone
  (several intervals per day are allowed). A staff resource can be linked to the person's login.
- *Services* have a length (or slot length), a turnaround buffer and a price.
- Each service lists the resources that can deliver it, grouped by **role**. A booking takes one free resource of
  every role, e.g. one *therapist* and one *room*.

**Availability** (`bk.availability`):
- Service mode offers start times every `booking.step_min` minutes (default 15). Slot mode offers one start per slot
  from each resource's opening time.
- A start time is offered when every role has a resource that is open for the whole appointment and not blocked or
  booked for the appointment plus its buffer.
- Bookings open `booking.max_days_ahead` days ahead (default 90) and start on 5-minute marks.

**No double booking:**
- `bk.book` first locks every candidate resource row (`FOR UPDATE`, in id order), then checks and picks. Concurrent
  bookings queue; they don't race.
- Among free resources, the least busy that day is picked, so work is spread across staff. A requested resource
  ("Ada, please") narrows the choice.
- Each held resource is a row in `appointment_resource` with a time range. The exclusion constraint
  `EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE (is_active)` guarantees no resource is held twice,
  even if the checks were bypassed. Clashes return 409 with a plain message ("no room is free for Swedish massage
  at Thu 15 Oct 11:00").

**Lifecycle:** `booked → checked_in → completed`, or `booked → cancelled | no_show`.
- Moving a booking re-picks its resources; the move screen keeps the same staff member unless unticked. The price stays as booked.
- Check-in happens on the day. Finishing early hands the rest of the time back to the schedule.
- Cancelling needs a reason. No-show is only possible after the start time. Both release the resources.

**Blocks:** blocked time (leave, lunch, maintenance) can't be booked. Creating a block over existing bookings is
refused and lists them.

**Who sees what:**
- Anyone with OPS in the unit sees the schedule.
- Staff whose only role there is *self*-scoped (therapists, attendants; `sec.is_self_only`) see only the bookings
  they are on. They can't book, move or block.
- Staff with a login are notified when a booking is made, moved or cancelled on their schedule.
- The System Owner sees the Spa read-only.

The Spa intake form (SEN data) comes with the Spa stage.

## Appointment bills (Content Studio; the Spa uses the same)

Every appointment has a bill (`BIL-<UNIT>-…`). It follows the guest-bill pattern: entries are permanent and signed
(charges +, payments −), and every entry is posted to the books through account 1100 (guest & client ledger).

- **Deposit:** each service has a deposit percentage. The booking shows the deposit due until it is paid, and the
  bookings list can filter *awaiting deposit*. Deposits are payments taken before the service:
  Dr 1000/1010/1020, Cr 1100. The bill is in credit until the booking is charged.
- **Payments** never exceed what is expected in total: the booking with service charge and VAT, plus add-ons.
  **Refunds** only of a credit balance. **Adjustments** (a manager, with a reason) reduce what is owed.
- **Add-ons:** any catalogue item on sale in the unit, e.g. equipment hire, editing hours or memory cards. They are
  charged with service charge and VAT (Dr 1100, Cr 4000 / 4100 / 2100).
  - A stock item leaves the chosen store at once (a `sale` movement, so cost of goods is posted). A recipe item uses
    its ingredients.
  - An add-on can be taken off while the bill is open: the lines are reversed and the stock goes back (`sale_void`).
- **Completing** the appointment charges the booking: Dr 1100, Cr 4300 Bookings revenue, plus 4100 and 2100.
- **Extending** (slot hire only, booked or under way) adds slots if the same booth is free. The price follows the slots.
- **Cancel / no-show** with a paid deposit: refund it first, or keep it as a cancellation or no-show fee
  (Dr 1100, Cr 4300). A bill with add-ons still owed must be settled first.
- The bill closes by itself once the appointment is over (completed, cancelled or no-show) and the balance is zero.
  The bookings list can filter *owing*.
- Only finance readers (FIN) see bills, balances and deposits. Staff whose only access is their own schedule see neither.

## Open decisions

- Partnership revenue share: which side the rate applies to, the revenue basis, who collects
  payments, and whether retail counts. The agreement table (stage 11) stores all four as settings.
- Department-level narrowing is enforced at the till (stage 4). Reading data is still unit-wide.
- Supplier payments (settling 2000 Accounts payable) and settling balances between units (1150 / 2200,
  now also created by charge-to-room) are not built yet.
