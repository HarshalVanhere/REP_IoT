# Fallback deployment: Render + Aiven MySQL (no card required)

Use this only if the Oracle Cloud VM path (`deploy/ORACLE_DEPLOYMENT.md`) isn't viable - e.g.
card verification gets rejected. This path needs **no card anywhere**, but trades away the
"genuinely always-on VM" property: Render's free web service sleeps after ~15 minutes with no
inbound HTTP traffic, and Aiven's free MySQL can power off after a period of inactivity.

**In practice this matters less than it sounds**: if you have a Raspberry Pi Edge Gateway
actively running (`IS_EDGE_GATEWAY=true`), its `syncService.js` posts to `/api/sync/data`
every 5 seconds - that's continuous inbound traffic, which keeps Render's free service awake
around the clock. The sleep/cold-start behavior only really shows up if nothing is actively
syncing yet and a human is just occasionally opening the dashboard.

## 1. Aiven MySQL (free, no card)

1. Sign up at aiven.io (no payment details required for the Free plan).
2. Create a new service → **MySQL** → Free plan → pick any region.
3. Once it's running, open the service's **Overview** tab and note: Host, Port, User (usually
   `avnadmin`), Password, and default database name.
4. Download the **CA Certificate** (`ca.pem`) from the same Overview tab - Aiven enforces TLS,
   which is why `backend/src/config/db.js` now supports `DB_SSL`/`DB_SSL_CA_PATH` (added
   alongside this fallback plan).
5. Once connected (see step 3 below), run the same schema setup used everywhere else in this
   repo: `cd backend && npm run db:setup` (point it at Aiven via the env vars first).

## 2. Render web service (free, no card)

1. Sign up at render.com (no card required for free tier).
2. **New → Blueprint**, connect this GitHub repo. Render reads `deploy/render.yaml`
   automatically if you point the Blueprint at the repo root - alternatively, create the web
   service manually with:
   - Build command: `cd frontend && npm ci && npm run build && cd ../backend && npm ci --omit=dev`
   - Start command: `node backend/src/server.js`
   - Health check path: `/api/health`
3. Under the service's **Environment** tab, fill in every variable marked `sync: false` in
   `deploy/render.yaml`:
   - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` - from Aiven's Overview tab
   - `JWT_SECRET`, `SYNC_API_KEY`, `MQTT_USERNAME`, `MQTT_PASSWORD` - generate each with
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `CORS_ORIGIN` - your Render service's URL (e.g. `https://rep-iot-backend.onrender.com`),
     or your own custom domain if you attach one
4. Under **Secret Files**, add a file at path `/etc/secrets/aiven-ca.pem` with the contents of
   the `ca.pem` you downloaded from Aiven in step 1 - this is what `DB_SSL_CA_PATH` in
   `render.yaml` already points to.
5. Deploy. Watch the logs for the same boot sequence verified locally and on the Oracle path
   (MQTT broker start, watchdog start, `Express & WS Server running`) with **no** mock-DB
   fallback line.

## 3. Verify

- `curl https://<your-service>.onrender.com/api/health` → `{"status":"ok","database":"connected",...}`
- Log in as `ADMIN` / `1234`, change the password immediately.
- Confirm `/api/machines` returns data and the dashboard's WebSocket connects.

## 4. Point the Edge Gateway at this URL

Same as the Oracle path - on each Raspberry Pi Edge Gateway, set in `backend/.env`:

```
CLOUD_BACKEND_URL=https://<your-service>.onrender.com
SYNC_API_KEY=<the same value you generated in step 2>
```

Restart that gateway's service and confirm sync logs show successful uploads.

## Later: upgrading off the free tier

If sleep/cold-start ever becomes a real problem (e.g. no Edge Gateway is live yet and
supervisors are hitting cold starts on the dashboard), Render's paid Starter plan
(~$7/mo, always-on, no sleep) is a drop-in upgrade of the exact same service - no
redeployment or config changes needed, just a plan change in the Render dashboard.
