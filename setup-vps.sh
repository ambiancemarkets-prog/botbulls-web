#!/usr/bin/env bash
# ==============================================================================
# BotBulls v3.0 (botbulls.com) — Ubuntu 22.04 / 24.04 VPS One-Click Setup Script
# Run as root or sudo user: sudo bash deploy/setup-vps.sh
# ==============================================================================
set -euo pipefail

DOMAIN="botbulls.com"
APP_DIR="/var/www/botbulls"

echo "=== [1/6] Updating system & installing Node.js 20, PostgreSQL, Nginx, Certbot ==="
apt-get update -y
apt-get install -y curl gnupg2 ca-certificates lsb-release ufw nginx certbot python3-certbot-nginx postgresql postgresql-contrib

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm install -g pm2

echo "=== [2/6] Configuring UFW Firewall (SSH, HTTP, HTTPS) ==="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "=== [3/6] Creating PostgreSQL Database & User ==="
DB_PASS="$(openssl rand -hex 16)"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='botbulls_user'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER botbulls_user WITH PASSWORD '${DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='botbulls_db'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE botbulls_db OWNER botbulls_user;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE botbulls_db TO botbulls_user;"

echo "=== [4/6] Installing App Dependencies & Initializing Schema ==="
mkdir -p "${APP_DIR}" "${APP_DIR}/logs" "${APP_DIR}/uploads" "${APP_DIR}/data"
cp -r . "${APP_DIR}/"
cd "${APP_DIR}"
npm install --omit=dev

if [ ! -f "${APP_DIR}/.env" ]; then
  JWT_GEN="$(openssl rand -hex 32)"
  cp .env.production.example .env
  sed -i "s|CHANGE_ME_DB_URL|postgresql://botbulls_user:${DB_PASS}@127.0.0.1:5432/botbulls_db|g" .env
  sed -i "s|CHANGE_ME_64_CHAR_JWT_SECRET|${JWT_GEN}|g" .env
  echo "Generated .env with fresh PostgreSQL password and JWT_SECRET."
fi

npm run db:init || echo "Note: Verify DATABASE_URL in .env and re-run 'npm run db:init' if needed."

echo "=== [5/6] Starting BotBulls with PM2 ==="
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" || true

echo "=== [6/6] Enabling Nginx Site ==="
cp deploy/nginx-botbulls.com.conf /etc/nginx/sites-available/botbulls.com
ln -sf /etc/nginx/sites-available/botbulls.com /etc/nginx/sites-enabled/botbulls.com
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "======================================================================"
echo "BotBulls v3.0 installed! Next steps:"
echo "1. Point DNS A records for botbulls.com & www.botbulls.com to this VPS IP."
echo "2. Edit ${APP_DIR}/.env to add your SMTP & Exchange API keys, then run: pm2 restart botbulls-app"
echo "3. Issue free HTTPS SSL certificate:"
echo "   sudo certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}"
echo "======================================================================"
