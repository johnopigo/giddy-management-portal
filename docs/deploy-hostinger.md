# Deploying on Hostinger (Node.js web app + managed PostgreSQL)

Hostinger's web hosting runs the portal itself (a Node.js web app, on the **Business** or **Cloud** plans), and the
database lives with a managed PostgreSQL provider. The portal keeps PostgreSQL because its access rules (Spa partner
isolation, the Owner's read-only view of the Spa, IT seeing no business data) and its no-double-booking guarantee are
enforced inside the database.

These steps use **[Neon](https://neon.com)** for the database. Supabase or DigitalOcean Managed PostgreSQL work
the same way: anything that gives you a PostgreSQL 16+ admin connection string.

```
guests and staff ──HTTPS──▶ portal.yourdomain.com (Hostinger Node.js web app) ──TLS──▶ Neon PostgreSQL
```

You need: the Hostinger plan, a Neon account, and Node.js 22 on your own computer for the one-time setup
(<https://nodejs.org>, "LTS").

## 1. Create the database (Neon)

1. Sign up at <https://neon.com> and create a project named `giddy`.
   - **PostgreSQL version:** 16 or 17.
   - **Region:** the one closest to where Hostinger hosts your site. Every page makes several database calls, so the
     two must be in the same part of the world: for example Hostinger UK with Neon **London**, or Hostinger
     France/Netherlands/Lithuania with Neon **Frankfurt**. (Your site's data-centre is shown in hPanel.)
2. On the project dashboard, click **Connect**, turn **Connection pooling off**, and copy the connection string.
   It looks like `postgresql://neondb_owner:…@ep-….neon.tech/neondb?sslmode=require`. This is the **admin
   connection string**; keep it private.

## 2. Prepare the database (once, from your computer)

```bash
git clone https://github.com/johnopigo/giddy-management-portal.git
cd giddy-management-portal
npm install
```

macOS / Linux:
```bash
ADMIN_DATABASE_URL='postgresql://neondb_owner:…/neondb?sslmode=require' npm run db:setup-remote
```
Windows PowerShell:
```powershell
$env:ADMIN_DATABASE_URL='postgresql://neondb_owner:…/neondb?sslmode=require'; npm run db:setup-remote
```

This creates the portal's two database logins with random passwords, the `giddy` database, and every table. At
the end it prints two lines, **`DATABASE_OWNER_URL=…`** and **`DATABASE_APP_URL=…`**. Copy both into your
password manager; they go into Hostinger in step 4. Running it again gives both logins new passwords (the data is
kept), and Hostinger then needs the new values.

## 3. Create the business and the first three people (once, from your computer)

macOS / Linux:
```bash
DATABASE_OWNER_URL='…from step 2…' PUBLIC_URL='https://portal.yourdomain.com' npm run setup-tenant -- \
  --name "Giddy Luxury Apartments" \
  --owner "Owner's Name <owner@yourdomain.com>" \
  --it "IT Admin's Name <it@yourdomain.com>" \
  --partner "Spa Partner's Name <spa@partner.com>"
```
Windows PowerShell:
```powershell
$env:DATABASE_OWNER_URL='…from step 2…'; $env:PUBLIC_URL='https://portal.yourdomain.com'
npm run setup-tenant -- --name "Giddy Luxury Apartments" --owner "Owner's Name <owner@yourdomain.com>" --it "IT Admin's Name <it@yourdomain.com>" --partner "Spa Partner's Name <spa@partner.com>"
```

It prints a **one-time password** for each person. Hand them out privately; each must choose a new password at
first sign-in. They are not stored anywhere.

## 4. Create the Node.js web app (Hostinger)

1. In hPanel: **Websites → Add website → Node.js Web App**.
2. **Source:** connect GitHub and choose `johnopigo/giddy-management-portal`, branch `main`.
3. **Domain:** choose your subdomain, for example `portal.yourdomain.com`. If your domain is with Hostinger, hPanel
   creates the DNS record and the HTTPS certificate itself. (If the domain is elsewhere, add the DNS record
   hPanel shows you at that provider.)
4. **Build settings:**

   | Setting | Value |
   |---|---|
   | Framework | **Express** (or "Other") |
   | Root directory | `/` (the repository root) |
   | Node.js version | **22** |
   | Package manager | npm |
   | Build command | `npm run build` |
   | Entry file | `app.js` |

5. **Environment variables** (you can also import them as a `.env` file):

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_OWNER_URL` | from step 2 |
   | `DATABASE_APP_URL` | from step 2 |
   | `RUN_MIGRATIONS` | `true` (database updates apply themselves on each deploy) |
   | `PUBLIC_URL` | `https://portal.yourdomain.com` |
   | `WEB_ORIGIN` | `https://portal.yourdomain.com` |
   | `COOKIE_SECURE` | `true` |
   | `DB_POOL_MAX` | `5` |
   | `PAYSTACK_SECRET_KEY` | your live key `sk_live_…` (can be added later) |

   Never set `PAYMENTS_TEST_MODE` here.
6. **Deploy.** When the build log finishes, open `https://portal.yourdomain.com/api/ready`. It should say
   `{"ok":true}`. Then open `https://portal.yourdomain.com` and sign in with a one-time password.

If `/api/ready` reports an error or the app does not start, open the app's **logs** in hPanel. The portal refuses
to start in production with unsafe settings and says which one; a database error usually means a mistyped
connection string.

## 5. Paystack

In the Paystack dashboard (Settings → API keys & webhooks), set the webhook URL to
`https://portal.yourdomain.com/api/public/paystack/webhook`, put the live secret key in `PAYSTACK_SECRET_KEY` in
hPanel, and redeploy. Each unit's managers then turn on online booking in **Organisation → settings**.

## 6. Importing existing records

The [import tool](data-import.md) runs from your computer with both connection strings, as a named staff member:

```bash
DATABASE_OWNER_URL='…' DATABASE_APP_URL='…' npm run import -- --as owner@yourdomain.com --kind customers --file customers.csv
```

(Add `--commit` after checking.) In PowerShell, set the two `$env:` values first as in step 3.

## 7. Backups

The Docker backup scripts in `ops/` are for the VPS route. With Neon:

- **Point-in-time restore** is built in: Neon can restore the database to any moment within its history window,
  which depends on the plan (short on the Free plan). For a live business, use a paid plan with at least 7 days.
- **Keep your own copies too**, for example weekly, with PostgreSQL's `pg_dump` on your computer:
  ```bash
  pg_dump --format=custom --file "giddy-$(date +%F).dump" 'DATABASE_OWNER_URL from step 2'
  ```
  Store the files somewhere safe and separate from the computer.

## 8. Updates

Merge changes into `main`, then **Redeploy** in hPanel (or turn on automatic deployment from GitHub). Database
updates apply themselves when the new version starts.

## Good to know

- **Neon Free** pauses the database after a few minutes without use; the first page after a quiet spell takes a
  couple of seconds longer. Its storage (0.5 GB) is plenty to start. A paid plan removes the pause and lengthens the
  restore window.
- **Sign-in throttling and booking limits** rely on seeing each visitor's address. If Hostinger's proxy hides it,
  every visitor looks the same. If people report "too many attempts" when they should not, the `trust proxy` setting in `server/src/app.js` needs adjusting for Hostinger.
- The **VPS route** in [deployment.md](deployment.md) runs everything (database included) on one server you control,
  with the Docker backup scripts; it remains the simplest option if Hostinger's web hosting gets in the way.
