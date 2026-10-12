#!/bin/bash
# =====================================================================================
# Giddy Management Portal: one-paste install on a new DigitalOcean droplet.
#
# 1. DigitalOcean → Create → Droplets: Ubuntu 24.04 LTS, Basic, 2 vCPU / 4 GB (or larger),
#    region London (LON1) or Frankfurt (FRA1), an SSH key or password, and tick "Monitoring".
# 2. Advanced options → "Add Initialization scripts (free)": paste this whole file.
#    Fill in the four lines below first (or leave them empty and do it later).
# 3. Create. After about 10 minutes the portal is live at https://<DOMAIN>, or, without a
#    domain, at https://<droplet-ip-with-dashes>.sslip.io (for example 164-90-1-23.sslip.io).
# 4. Open the droplet's Console in DigitalOcean and run:  cat /root/giddy-first-sign-in.txt
#    for the address and the three one-time passwords. Progress: tail -f /var/log/giddy-install.log
# =====================================================================================

# Your web address, if its DNS A record already points at this droplet (else leave empty).
DOMAIN=""
# The business and its first three people, as "Full Name <email>" (leave empty to do it later).
BUSINESS_NAME="Giddy Luxury Apartments"
OWNER=""
IT_ADMIN=""
SPA_PARTNER=""
# Paystack live secret key (sk_live_…); online deposits stay off until it is set. Better added later in
# /opt/giddy/.env.production: anything pasted here stays readable in the droplet's metadata.
PAYSTACK_SECRET_KEY=""

# ------------------------------------------------------------------------------------
set -euo pipefail
exec > >(tee -a /var/log/giddy-install.log) 2>&1
echo "== Giddy install started $(date -u)"
export DEBIAN_FRONTEND=noninteractive
APP_DIR=/opt/giddy
REPO=https://github.com/johnopigo/giddy-management-portal.git

# Swap, so building the web app never runs out of memory on a small droplet.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Firewall: SSH and the web only.
apt-get update -y
apt-get install -y ufw git curl openssl ca-certificates unattended-upgrades
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Docker.
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi

# The code.
if [ ! -d "$APP_DIR/.git" ]; then git clone --depth 1 "$REPO" "$APP_DIR"; fi
cd "$APP_DIR"

# The address: the given domain, or this droplet's public IP through sslip.io.
if [ -z "$DOMAIN" ]; then
  IP=$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || curl -fsS https://api.ipify.org)
  DOMAIN="${IP//./-}.sslip.io"
fi

# Production settings with fresh random passwords (kept only on this server).
if [ ! -f .env.production ]; then
  PG_PW=$(openssl rand -hex 24); OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)
  umask 077
  cat > .env.production <<ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$PG_PW
DB_OWNER_PASSWORD=$OWNER_PW
DB_APP_PASSWORD=$APP_PW
PAYSTACK_SECRET_KEY=$PAYSTACK_SECRET_KEY
SESSION_TTL_HOURS=12
ENV
  umask 022
fi

# Build and start (the database, the portal and Caddy for HTTPS).
docker compose --env-file .env.production up -d --build
echo "== waiting for the portal to be ready"
for _ in $(seq 1 60); do
  if docker compose --env-file .env.production exec -T app wget -qO- http://127.0.0.1:4000/api/ready >/dev/null 2>&1; then break; fi
  sleep 5
done

# The business and its first three people, with one-time passwords.
OUT=/root/giddy-first-sign-in.txt
{
  echo "Giddy Management Portal: https://$DOMAIN"
  echo
} > "$OUT"
chmod 600 "$OUT"
if [ -n "$OWNER" ] && [ -n "$IT_ADMIN" ] && [ -n "$SPA_PARTNER" ]; then
  docker compose --env-file .env.production exec -T app node server/scripts/setup-tenant.js \
    --name "$BUSINESS_NAME" --owner "$OWNER" --it "$IT_ADMIN" --partner "$SPA_PARTNER" >> "$OUT" 2>&1 || true
else
  cat >> "$OUT" <<TXT
No people were set up yet. Run (with real names and emails):
  cd $APP_DIR && docker compose --env-file .env.production exec app node server/scripts/setup-tenant.js \\
    --name "$BUSINESS_NAME" --owner "Name <owner@example.com>" --it "Name <it@example.com>" --partner "Name <spa@example.com>"
TXT
fi
echo >> "$OUT"
echo "Delete this file once the passwords have been handed out: rm $OUT" >> "$OUT"

# Nightly backups at 02:15 (server time), kept 14 days. Copy them off the server too: see docs/deployment.md.
mkdir -p "$APP_DIR/backups" && chmod 700 "$APP_DIR/backups"
( { crontab -l 2>/dev/null || true; } | { grep -v giddy-backup || true; } ; echo "15 2 * * * cd $APP_DIR && ops/backup.sh >> backups/backup.log 2>&1 # giddy-backup" ) | crontab -

echo "== Giddy install finished $(date -u): https://$DOMAIN"
