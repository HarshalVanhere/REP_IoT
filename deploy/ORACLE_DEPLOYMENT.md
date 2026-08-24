# Deploying REP_IoT to Oracle Cloud (Always Free VM)

This replaces the Railway-hosted "Cloud" tier with a permanent Oracle Cloud Always Free Ubuntu
VM. Nothing on Railway is touched by this process. See `deploy/bootstrap.sh` (VM setup script),
`deploy/env.production.template` (`.env` values), and `deploy/nginx-rep-iot.conf.template`
(reverse proxy) — this doc ties them together in order.

## 1. Create the Oracle Cloud VM

In the Oracle Cloud Console:

1. **Compute → Instances → Create Instance**.
2. Image: **Ubuntu 22.04** (Always Free eligible).
3. Shape: an Always Free shape — either `VM.Standard.A1.Flex` (Ampere ARM, up to 4 OCPU/24GB
   under the Always Free limits) or `VM.Standard.E2.1.Micro` (AMD, smaller but simpler/x86).
   Either works for this app; A1 has more headroom.
4. Add your SSH public key (or generate a new key pair and download the private key).
5. Create the instance and note its **public IP address**.

### Security List (firewall at the cloud level)

Under the VM's attached **Virtual Cloud Network → Security Lists**, add ingress rules for:

- TCP 22 (SSH) — ideally restricted to your own IP's `/32` CIDR, not `0.0.0.0/0`
- TCP 80 (HTTP, for Let's Encrypt's validation + redirect to HTTPS)
- TCP 443 (HTTPS)

Do **not** open 3306 (MySQL) or 1883 (MQTT) — both stay local-only to this VM (see the
migration plan's rationale: Edge Gateways sync over HTTPS only, never talk to MySQL/MQTT
directly).

### DNS

Point your domain's **A record** at the VM's public IP (e.g. `cnc.example.com → <public IP>`).
Wait for it to propagate (`dig cnc.example.com` should return the VM's IP) before running
certbot in step 5 — Let's Encrypt validates ownership over HTTP on that domain.

## 2. Bootstrap the VM

SSH in and run the bootstrap script:

```bash
ssh -i /path/to/your/key.pem ubuntu@<public IP>

# On the VM:
git clone https://github.com/<your-org>/REP_IoT.git
cd REP_IoT/deploy
chmod +x bootstrap.sh
DB_APP_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" 2>/dev/null || openssl rand -hex 24)" ./bootstrap.sh
```

(If `node` isn't installed yet to generate that password, just omit `DB_APP_PASSWORD=...` —
the script generates and prints one for you.)

This installs Node 20, MySQL, nginx, certbot, sets up `ufw`, creates the `cnc_app` MySQL user,
clones the repo, installs dependencies, builds the frontend, and installs (but does not yet
start) the systemd unit. **Save the printed `DB_APP_PASSWORD` value** — you need it next.

## 3. Configure the app

```bash
cd ~/REP_IoT/backend
cp ../deploy/env.production.template .env
nano .env   # fill in every <REPLACE_...> placeholder
```

Fill in:
- `DB_PASSWORD` — the value bootstrap.sh printed/generated
- `JWT_SECRET`, `SYNC_API_KEY`, `MQTT_PASSWORD` — generate each with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `CORS_ORIGIN` — `https://<your domain>` (exact match, no trailing slash)

Then create the database schema:

```bash
npm run db:setup
```

## 4. nginx + HTTPS

```bash
sudo cp ~/REP_IoT/deploy/nginx-rep-iot.conf.template /etc/nginx/sites-available/rep-iot
sudo nano /etc/nginx/sites-available/rep-iot   # replace <REPLACE_WITH_YOUR_DOMAIN>
sudo ln -s /etc/nginx/sites-available/rep-iot /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Only once the domain's A record actually resolves to this VM:
sudo certbot --nginx -d <your domain>
```

Certbot rewrites the nginx config in place to add the HTTPS server block, the HTTP→HTTPS
redirect, and a renewal timer.

## 5. Start the app

```bash
sudo systemctl enable --now rep-iot-backend
journalctl -u rep-iot-backend -f
```

You should see the same boot sequence verified locally during development — MQTT broker
starting, watchdog starting, `Express & WS Server running` — with **no** "Falling back to
IN-MEMORY MOCK database" line. If that line appears, `.env` isn't being picked up correctly
(NODE_ENV/DB_PASSWORD) — production mode will actually refuse to start rather than silently
run on mock data (see `backend/src/config/db.js`), so a boot failure here means check `.env`
first.

## 6. Verify

- `curl https://<your domain>/api/health` → `{"status":"ok","database":"connected",...}`
- Open `https://<your domain>` in a browser, log in as `ADMIN` / `1234` (seeded default — see
  next step), confirm the dashboard loads and live updates arrive (WebSocket connects).
- **Change the default admin password immediately** via the dashboard's account settings
  (`POST /api/auth/change-password`) — `1234` is a seed value, not meant to survive go-live.
- `sudo mysql -u cnc_app -p cnc_dashboard -e "SHOW TABLES;"` — confirms the scoped app user
  (not root) can see the schema `db:setup` created.
- `sudo ufw status` — confirms only 22/80/443 are open.
- `sudo certbot renew --dry-run` — confirms auto-renewal is wired up correctly.

## 7. Point the Edge Gateway(s) at the new Cloud tier

On each Raspberry Pi Edge Gateway currently pointed at Railway, update `backend/.env`:

```
CLOUD_BACKEND_URL=https://<your domain>
SYNC_API_KEY=<the same SYNC_API_KEY you generated in step 3>
```

Then restart that gateway's service (`sudo systemctl restart cnc-backend` or your Pi's
equivalent unit name) and confirm its logs show successful sync uploads to the new domain
within one 5-second cycle (`syncService.js`'s interval).

## Notes

- Railway is not referenced, modified, or depended on anywhere in this process. Once you've
  confirmed the new VM is fully working end-to-end (including at least one real Edge Gateway
  sync cycle), you can decommission the Railway project on your own schedule — this doc
  doesn't do that for you.
- To deploy a code update later: `git -C ~/REP_IoT pull`, re-run the relevant parts of
  `bootstrap.sh` (dependency installs / frontend build) if `package.json` changed, then
  `sudo systemctl restart rep-iot-backend`.
