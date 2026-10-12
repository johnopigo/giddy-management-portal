# Importing existing records

Existing records can be brought in from spreadsheets saved as **CSV** (in Excel: *File → Save As → CSV UTF-8*).
The import tool goes through the portal's own rules, **as a named staff member**: it can only do what that person
could do on screen, and the audit trail shows them as having created every record.

Templates with the expected columns are in [`docs/import-templates`](import-templates). The first row must be the
column names; the order of columns does not matter, and extra columns are ignored (with a warning).

## Running it

On the server, copy the file into the portal container and **check it first** (nothing is written):

```bash
docker compose --env-file .env.production cp customers.csv app:/tmp/customers.csv
docker compose --env-file .env.production exec app node server/scripts/import.js \
  --as owner@giddyluxury.com --kind customers --file /tmp/customers.csv
```

The check reports every row with a problem by its line number in the file. Fix those rows, check again, then add
`--commit` to import:

```bash
docker compose --env-file .env.production exec app node server/scripts/import.js \
  --as owner@giddyluxury.com --kind customers --file /tmp/customers.csv --commit
```

Rows that already exist are **skipped**, so a file can safely be imported again after fixing the rows that failed.
The person named in `--as` must have signed in once and changed their one-time password.

In development: `npm run import -w server -- --as owner@giddy.local --kind customers --file customers.csv`.

## What can be imported, in this order

| Kind | Columns (**required** in bold) | Notes |
|---|---|---|
| `customers` | **full_name**, phone, email, date_of_birth | A phone number or an email is needed. A phone or email already on file is skipped (customers are shared by all units). Dates as `YYYY-MM-DD`. |
| `suppliers` | **name**, contact_name, phone, email, tax_id, address | |
| `items` | **sku**, **name**, **uom**, category, owner_unit, stockable, sellable | Units of measure and categories are created if new. `owner_unit` is the unit code (`FNB`, `SPA`, …); leave empty for shared items. `stockable`/`sellable`: yes or no. Spa items must be imported by the Spa partner (the Owner only reads the Spa). |
| `prices` | **sku**, **unit**, sell_price, reorder_level, reorder_qty | Turns an item on in a unit, with its selling price (before VAT and service charge) and reorder levels. |
| `room-types` | **code**, **name**, **base_rate**, description, max_adults, max_children, amenities | Amenities separated by `;`. Use `--unit` if there is more than one apartments unit. |
| `rooms` | **room_number**, **room_type**, floor, branch | `room_type` is the room type's code or name. |
| `locations` | **unit**, **name**, department, parent, branch | Stock locations. A department's store (for example the Bar store) sits under a main store: put the main store's name in `parent`. Import main stores first. |
| `opening-stock` | **unit**, **location**, **sku**, **qty**, unit_cost, batch_no, expiry_date | Opening stock counted on go-live day. `unit_cost` is what one unit cost, and sets the opening stock value. The item must be on in that unit (`prices`). An item that already has an opening balance at that location is skipped. |

Unit codes: `APARTMENTS`, `FNB`, `STUDIO`, `SPA` (the unit's name also works).

## What is not imported

- **Past sales, stays and appointments.** The portal starts its books on go-live day. Keep the old system's
  records available read-only for reference.
- **Opening cash, bank and other ledger balances**: the accountant records them at the start of the first period.
- **Staff accounts**: IT creates them in **Users**, so each person gets their own one-time password and roles.
- **Future reservations and appointments already promised to guests**: enter them on screen at the front desk or in
  Appointments, so each gets a real room or time and a booking reference.
