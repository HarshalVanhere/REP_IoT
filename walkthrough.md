# Walkthrough: CNC Monitoring System Fixes & Optimizations

This walkthrough documents the successful implementation and verification of the repairs, security enhancements, and optimizations made to the CNC monitoring platform.

## Changes Made

### Component: Frontend

1. **Terminal Crash Fix (`OperatorTerminal.jsx`)**
   - Extracted `assigned_operator` and `active_part_name` from the `machine` object. This avoids a `ReferenceError` when rendering the operator login screen.
2. **Handle `SYNC_UPDATE` (`App.jsx`)**
   - Added support for handling `SYNC_UPDATE` events broadcasted from the WebSocket server.
   - Refreshes machine counts (`production_count`, `good_count`, `scrap_count`, `last_pulse`, `status`), recalculates OEE metrics, and updates logs and historical charts.
3. **Dynamic API Configuration (`.env` and `.env.example`)**
   - Cleared hardcoded Railway endpoints, enabling dynamic resolution via `window.location.origin`. When blank, the dashboard dynamically communicates with the serving machine (e.g. localhost/Pi in local gateway mode and Railway in cloud deployment).

### Component: Backend

1. **Control Command Acknowledgement Registry (`serialService.js`)**
   - Added a promise-based command callback registry in `sendSerialCommand` to wait for JSON `ack` telemetry from the ESP32.
   - Integrated dynamic simulation (immediate resolution) when running in Cloud Mode (`IS_EDGE_GATEWAY !== 'true'`).
2. **Synchronous Stop/Resume Endpoints (`api.js`)**
   - Updated `/machines/:id/stop` and `/machines/:id/resume` to `await` confirmation from the physical interlock relay before transitioning the DB status and returning success.
   - Updated the cloud sync endpoint to query and attach the latest machine counts to the `SYNC_UPDATE` WebSocket broadcast.
3. **Mock DB Fallback Lockout (`db.js`)**
   - Added checks to prevent falling back to the temporary in-memory mock database if `NODE_ENV === 'production'`. The server will log a fatal error and exit (exit code 1) instead of running silently on temporary data.
4. **Optimized OEE Calculation (`oeeCalculator.js`)**
   - Refactored `calculateOEE` to retrieve shift counts using optimized SQL aggregates and query the last cycle time using a `LIMIT 1` query.
   - Bypasses retrieving thousands of raw pulse rows since midnight, making pulse processing extremely fast and scalable. Preserves the original JavaScript aggregation for the mock database mode.
5. **Stale Pulse Watchdog (`watchdogService.js` and `server.js`)**
   - Created a background watchdog service polling every 10 seconds.
   - Automatically transitions a running machine to `Stopped` if it has not received a pulse within `Math.max(ideal_cycle_time * 5, 120)` seconds.

### Component: Firmware (`esp32_cnc_monitor.ino`)

1. **GPIO Pin Reassignment**
   - Moved the CNC interlock relay driver pin `PIN_RUN_ENABLE` from GPIO 12 (strapping pin) to GPIO 27 to avoid boot looping/unstable booting caused by external relay coil loads pulling GPIO 12 during startup.
2. **Command Acknowledgement telemetry**
   - Emits JSON acknowledgments (`{"type":"ack","command":"resume|stop","status":"success"}`) upon executing control commands.
   - Forces an immediate status report to synchronize the backend.
3. **State Overwrite Protection**
   - Ensured `sendCurrentStatus` forces status to `Stopped` if the interlock run enablement is low (PIN_RUN_ENABLE is LOW). This stops the green stack-light from overriding touchscreen Stop commands.
4. **Cycle Timer Reset**
   - Resets the `lastCycleStart` timestamp when the machine transitions from `Stopped` to `Running` (upon resume command or stack-light change), ensuring correct post-stop cycle times.

---

## Validation & Verification Results

### 1. Frontend Build Verification
- **Command**: `npm run build` inside `/frontend`
- **Result**: Successfully compiled and generated production chunks without errors.
  - Production Bundle: `dist/assets/index-BG4KO0YC.js` (678.51 kB minified)

### 2. Backend Dev-Mode Initialization
- **Command**: `node src/server.js` (with default configuration)
- **Result**: Server started successfully and logged:
  ```
  ⚠️  Database password is unset or placeholder. Falling back to IN-MEMORY MOCK database mode.
  ✅ Seeded mock database: 477 pulses, 48 downtime cycles.
  ☁️  Running in Cloud Mode (Local Sync Client Disabled)
  ☁️  Running in Cloud Mode (Serial Listener Disabled)
  ⏰ Watchdog Service: Starting background stale-pulse monitor...
  🚀 Embedded MQTT Broker listening on port 1883
  💻 Express & WS Server running on http://localhost:5001
  ```
- **Confirmation**: Watchdog service, HTTP server, and MQTT broker initialized perfectly.

### 3. Production DB Lockout Verification
- **Command**: `$env:NODE_ENV="production"; node src/server.js` (with placeholder DB password)
- **Result**: Process terminated immediately with exit code 1 and logged the fatal database error:
  ```
  ❌ Production Error: Failed to connect to MySQL database: Database password is unset or placeholder. Database connection is required in production mode.
  ```
- **Confirmation**: Disabling of in-memory mock database in production is fully enforced.
