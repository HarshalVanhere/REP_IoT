#!/usr/bin/env bash
# One-time setup for a fresh Oracle Cloud Ubuntu VM to host the REP_IoT backend.
#
# Run as the default cloud-init user (usually "ubuntu") via SSH on the VM itself:
#   chmod +x bootstrap.sh && ./bootstrap.sh
#
# Idempotent where reasonably possible (apt/npm installs are naturally idempotent; the
# MySQL user/database creation uses IF NOT EXISTS). Safe to re-run if a step fails partway.
#
# What this does NOT do (see deploy/ORACLE_DEPLOYMENT.md for these manual steps):
#   - Create the Oracle VM itself / configure the cloud Security List
#   - Point DNS at the VM
#   - Fill in backend/.env (uses deploy/env.production.template as a starting point)
#   - Run certbot (needs the domain to already resolve to this VM first)
#   - Enable/start the systemd service (needs .env in place first)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/<REPLACE_WITH_YOUR_GITHUB_ORG>/REP_IoT.git}"
APP_DIR="${APP_DIR:-$HOME/REP_IoT}"
NODE_MAJOR=20

echo "==> Updating apt and installing base packages"
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl git ufw software-properties-common

echo "==> Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_MAJOR}.* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "==> Installing MySQL Server"
sudo apt-get install -y mysql-server
sudo systemctl enable --now mysql

echo "==> Creating dedicated app database + user (idempotent)"
DB_APP_PASSWORD="${DB_APP_PASSWORD:-}"
if [[ -z "$DB_APP_PASSWORD" ]]; then
  echo "!! DB_APP_PASSWORD env var not set - generating one now. SAVE THIS VALUE:"
  DB_APP_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  echo "   DB_APP_PASSWORD=${DB_APP_PASSWORD}"
fi
sudo mysql <<SQL
CREATE DATABASE IF NOT EXISTS cnc_dashboard;
CREATE USER IF NOT EXISTS 'cnc_app'@'localhost' IDENTIFIED BY '${DB_APP_PASSWORD}';
ALTER USER 'cnc_app'@'localhost' IDENTIFIED BY '${DB_APP_PASSWORD}';
GRANT ALL PRIVILEGES ON cnc_dashboard.* TO 'cnc_app'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "   MySQL user 'cnc_app' ready - use the DB_APP_PASSWORD above as DB_PASSWORD in backend/.env"

echo "==> Installing nginx + certbot"
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx

echo "==> Configuring ufw firewall (22, 80, 443 only)"
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo ufw status verbose

echo "==> Cloning/updating the repo at ${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" pull
else
  git clone "${REPO_URL}" "${APP_DIR}"
fi

echo "==> Installing backend dependencies"
cd "${APP_DIR}/backend"
npm ci --omit=dev

echo "==> Installing frontend dependencies and building"
cd "${APP_DIR}/frontend"
npm ci
npm run build

echo "==> Installing systemd unit (not starting yet - backend/.env doesn't exist until you fill it in)"
sudo cp "${APP_DIR}/backend/cnc-backend.service" /etc/systemd/system/rep-iot-backend.service
sudo systemctl daemon-reload

cat <<EOF

==================================================================
Bootstrap complete. Remaining manual steps (see deploy/ORACLE_DEPLOYMENT.md):

1. Copy deploy/env.production.template to backend/.env and fill in:
     DB_PASSWORD   = ${DB_APP_PASSWORD}
     JWT_SECRET, SYNC_API_KEY, MQTT_PASSWORD (generate each with:
       node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
     CORS_ORIGIN   = https://<your domain>

2. Run the DB schema setup:
     cd ${APP_DIR}/backend && npm run db:setup

3. Start the systemd service (already installed as rep-iot-backend):
     sudo systemctl enable --now rep-iot-backend
     journalctl -u rep-iot-backend -f

4. Set up nginx (deploy/nginx-rep-iot.conf.template) and run certbot for HTTPS.
==================================================================
EOF
