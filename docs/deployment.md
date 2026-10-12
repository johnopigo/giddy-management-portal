# Deploying the portal

The portal runs as three containers on one Linux server:

| Container | What it does |
|---|---|
| `db` | PostgreSQL 16. Holds everything; the only thing that needs backing up. |
| `app` | The portal (API and web pages in one Node.js service). Applies database updates itself when it starts. |
| `caddy` | Takes the web address, gets and renews the HTTPS certificate automatically, passes requests to `app`. |

Any cloud provider works: a virtual machine with **2 vCPUs, 4 GB memory and 40 GB disk** is plenty to start
(for example a DigitalOcean droplet, AWS Lightsail, Hetzner or an Azure B2s). Choose a region close to Lagos.

## DigitalOcean in one paste

[`ops/digitalocean-user-data.sh`](../ops/digitalocean-user-data.sh) does sections 1–4 and the nightly backup
schedule by itself on a new droplet:

1. In DigitalOcean: **Create → Droplets**. Choose **Ubuntu 24.04 LTS**, **Basic**, **Regular, 2 vCPU / 4 GB**, region
   **London (LON1)** or **Frankfurt (FRA1)** (the closest to Lagos), and add your SSH key or a root password. Tick
   **Monitoring**, and **Backups** if you want DigitalOcean's weekly droplet backups as well.
2. Under **Advanced options → Add Initialization scripts**, paste the whole file. Before pasting, fill in at its top:
   `DOMAIN` (leave empty for now if the address isn't set up yet), and `OWNER`, `IT_ADMIN`, `SPA_PARTNER` as
   `Full Name <email>`. `PAYSTACK_SECRET_KEY` can be added later.
3. Click **Create Droplet** and wait about 10 minutes.
4. Open the droplet's **Console** (in its DigitalOcean page) and run `cat /root/giddy-first-sign-in.txt`. It shows the
   portal's address and the three one-time passwords. Hand them out, then delete the file.

Without a domain, the address is `https://<droplet IP with dashes>.sslip.io` (for example
`https://164-90-1-23.sslip.io`), with a real HTTPS certificate. To move to your own address later: add a DNS **A
record** pointing it at the droplet's IP, set `DOMAIN` in `/opt/giddy/.env.production`, and run
`cd /opt/giddy && docker compose --env-file .env.production up -d`. Then update the Paystack webhook URL.

If something goes wrong, the install log is `/var/log/giddy-install.log`.

The rest of this guide covers the same steps by hand, for any provider.

## 1. Prepare the server

1. Create the VM with Ubuntu 24.04 LTS and install Docker: `curl -fsSL https://get.docker.com | sh`.
2. Open only ports 22 (SSH), 80 and 443 in the provider's firewall.
3. Point the portal's address (for example `portal.giddyluxury.com`) at the server's IP with a DNS **A record**.
4. Copy the code to the server, for example `git clone https://github.com/johnopigo/giddy-management-portal /opt/giddy`.

## 2. Configure

```bash
cd /opt/giddy
cp ops/production.env.example .env.production
chmod 600 .env.production
nano .env.production
```

| Setting | Value |
|---|---|
| `DOMAIN` | the portal's address, without `https://` |
| `POSTGRES_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD` | three different long random values: `openssl rand -base64 24` |
| `PAYSTACK_SECRET_KEY` | the live secret key (`sk_live_…`). Leave it empty until Paystack is ready; online deposits stay off until then. |

Never commit `.env.production`; it is ignored by git. Keep a copy of it in the business password manager.

The portal **refuses to start** in production if the address is not HTTPS, the cookies are not secure, a database
password is still the development default, or the test payment gateway is switched on.

## 3. Start

```bash
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps        # all three "Up"; app "(healthy)"
```

The first start creates the database and applies every database update. Open `https://<DOMAIN>`: the sign-in page
should load with a valid certificate.

## 4. Create the business and the first three people

```bash
docker compose --env-file .env.production exec app node server/scripts/setup-tenant.js \
  --name "Giddy Luxury Apartments" \
  --owner "Owner's Name <owner@giddyluxury.com>" \
  --it "IT Admin's Name <it@giddyluxury.com>" \
  --partner "Spa Partner's Name <spa@partner.com>"
```

This creates the four units, the Owner, the IT administrator and the Spa partner's first user, and prints a
**one-time password** for each. Hand each password to its person privately; each must choose a new one when they
first sign in. The passwords are not stored or shown again (the Owner or IT can reset a lost one). The script refuses
to run a second time. The development seed (`owner@giddy.local`) cannot run in production.

Then the IT administrator creates everyone else's accounts in **Users**, and existing records can be brought in with
the [import tool](data-import.md).

## 5. Online booking and Paystack

1. In the Paystack dashboard (Settings → API keys & webhooks), set the **webhook URL** to
   `https://<DOMAIN>/api/public/paystack/webhook`, and copy the live secret key into `PAYSTACK_SECRET_KEY`.
2. Apply it: `docker compose --env-file .env.production up -d`.
3. Each unit's managers turn on online booking in **Organisation → settings** (`online.enabled` = `true`) and set
   deposits and limits there. The public booking page's address is shown on the Organisation page.

Make a real booking with a small deposit and refund it from the Paystack dashboard before announcing the page.

## 6. Backups

The database is backed up with `ops/backup.sh`: it writes `backups/giddy-<date>.dump`, checks the file can be read
back, and deletes backups older than 14 days (`KEEP_DAYS`). Run it every night from cron:

```bash
mkdir -p backups && chmod 700 backups
sudo crontab -e
# add:
15 2 * * *  cd /opt/giddy && ops/backup.sh >> backups/backup.log 2>&1
```

**Copy backups off the server.** A backup on the same machine does not survive losing the machine. Set
`BACKUP_COPY_CMD` to any command that uploads the file (`$1`), for example with
[rclone](https://rclone.org) to the provider's object storage:

```bash
15 2 * * *  cd /opt/giddy && BACKUP_COPY_CMD='rclone copy "$1" offsite:giddy-backups' ops/backup.sh >> backups/backup.log 2>&1
```

Also turn on the provider's own weekly VM snapshots.

### Restoring

```bash
ops/restore.sh backups/giddy-20261012T021500Z.dump --yes
```

This stops the portal, replaces the database with the backup, checks the audit trail is intact, and starts the
portal again. If the audit check fails, the portal stays stopped so the problem can be looked at first.
**Practise a restore before going live**, ideally on a second server, and then every few months.

## 7. Updates

```bash
cd /opt/giddy
ops/backup.sh                                          # always back up first
git pull
docker compose --env-file .env.production up -d --build
```

Database updates are applied automatically when the new version starts (several copies starting at once wait for
each other). If something goes wrong, check out the previous version, rebuild, and restore the backup taken
just before.

## 8. Day to day

| Task | Command |
|---|---|
| Is it running? | `docker compose --env-file .env.production ps` |
| Recent requests and errors | `docker compose --env-file .env.production logs --tail 200 app` |
| Restart the portal | `docker compose --env-file .env.production restart app` |
| Readiness check (for an uptime monitor) | `https://<DOMAIN>/api/ready` returns 200 when the database is reachable |

Each request is logged as one line (method, path, status, time, user id). Secret parts of guests' booking links are
never logged. An error shown to a user carries a reference id that matches the log line.

Set up a free uptime monitor (for example UptimeRobot or Better Stack) on `https://<DOMAIN>/api/ready`.

## Security notes

- Only Caddy is reachable from the internet; the database has no public port.
- Sign-in is paused for 15 minutes after 5 wrong passwords for the same email from the same network address (or 50
  from anywhere), without locking the real person out from elsewhere.
- Online bookings are limited: a few unpaid bookings per guest or address, a cap on unpaid holds per unit, a maximum
  stay and how far ahead, and holds released after 15 minutes. These are unit settings (`online.*`).
- Give Spa and Studio services a deposit if fake free bookings become a problem.
