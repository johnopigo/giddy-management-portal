# Giddy Management Portal

One web platform for the four businesses at Giddy Luxury Apartments:

| Business unit | Managed by | Booking model |
|---|---|---|
| Luxury Apartments | Owner | Room-nights |
| Food & Beverage | Owner | Point of sale |
| Content Studio | Owner | Booths rented by the hour |
| Spa | **Partnership** | Treatments with a therapist and room |

The Owner has full control of the three owner-managed units and a **read-only** view of the Spa.
The Spa Partner has full control of the Spa and **no access** to the other units.
IT manages user accounts everywhere but sees **no business data**.

These rules are enforced inside PostgreSQL with row-level security, so they hold even if
the application code has a bug. See [docs/architecture.md](docs/architecture.md).

## Stack

- **web/** — React 19 + Vite (JavaScript)
- **server/** — Node.js 22 + Express 5 (JavaScript, ES modules)
- **PostgreSQL 16** — row-level security, append-only hash-chained audit log

## Run it locally

Prerequisites: Node.js 22+, PostgreSQL 16+.

```bash
# 1. Create the database and the two login roles (as a PostgreSQL superuser)
sudo -u postgres bash server/scripts/db-setup.sh
sudo -u postgres DB_NAME=giddy_test bash server/scripts/db-setup.sh   # for the tests

# 2. Configure and install
cp .env.example .env
npm install

# 3. Create the schema and a development tenant
npm run migrate
npm run seed        # prints the sign-in details

# 4. Start the API (port 4000) and the web app (port 5173) in two terminals
npm run dev:server
npm run dev:web
```

Open http://localhost:5173 and sign in as `owner@giddy.local`, `it@giddy.local` or
`partner@giddy.local` (development password `GiddyDev2026`).

## Tests

```bash
npm test
```

Server tests run against the `giddy_test` database, which is wiped and rebuilt for every test
file. They exercise the real database rules through the HTTP API.

## Build stages

| Stage | Scope | Status |
|---|---|---|
| 1 | Foundations: organisation, users, roles, partner approvals, row-level security, audit log | **Done** |
| 2 | Item & supplier masters, three-tier stock locations, stock ledger (FEFO), shared customers | **Done** |
| 3 | Procurement: purchase orders, goods receiving, average costing, transfers between units, item requests, notifications | **Done** |
| 4 | Point of sale and finance core (double-entry postings, voids, period close) | Next |
| 5 | Food & Beverage: recipes, production orders | |
| 6–7 | Luxury Apartments: rooms, reservations, folios, housekeeping, charge-to-room | |
| 8 | Booking engine (service-based and slot-based) | |
| 9 | Content Studio booth rentals | |
| 10 | Spa operations | |
| 11 | Partnership settlements | |
| 12–13 | Online booking portals with Paystack | |
| 14 | Reports and group dashboard | |
| 15–16 | Hardening, migration, go-live | |
