# CNC Monitoring System Repair and Optimization Plan

This implementation plan details the steps to address the major frontend, backend, configuration, and firmware issues identified in the system.

## Proposed Changes

---

### Component: Frontend

#### [MODIFY] [OperatorTerminal.jsx](file:///G:/REP_IoT/frontend/src/components/OperatorTerminal.jsx)
- **Fix Terminal Crash**: Destructure `assigned_operator` and `active_part_name` from the `machine` object. This avoids a `ReferenceError` when displaying the PPC pre-assigned login mode.

#### [MODIFY] [App.jsx](file:///G:/REP_IoT/frontend/src/App.jsx)
- **Handle `SYNC_UPDATE`**: Add a handler for the `SYNC_UPDATE` WebSocket message. This will update the machine's production counts (`production_count`, `good_count`, `scrap_count`, `last_pulse`, `status`), recalculate OEE metrics, and refresh the pulse history chart and reports.

#### [MODIFY] [.env.example](file:///G:/REP_IoT/frontend/.env.example) and [.env](file:///G:/REP_IoT/frontend/.env)
- **Dynamic Local Gateway / Cloud Configuration**: Comment out or clear `VITE_API_URL` and `VITE_WS_URL` by default. When blank, the frontend dynamically uses `window.location.origin` (relative addressing) so that:
  - If loaded from the Pi, it automatically uses the local serial gateway.
  - If loaded from Railway, it automatically connects to the cloud.

---

### Component: Backend

#### [MODIFY] [api.js](file:///G:/REP_IoT/backend/src/routes/api.js)
- **Confirm Serial Control**: Refactor `/stop` and `/resume` endpoints to wait (`await`) for the physical ESP32 to acknowledge the serial command before returning success.
- **Enrich `SYNC_UPDATE` Broadcast**: Query and attach the updated machine counts (`production_count`, `good_count`, `scrap_count`, `last_pulse`, `status`) to the `SYNC_UPDATE` WebSocket broadcast so the frontend doesn't show stale counts.

#### [MODIFY] [serialService.js](file:///G:/REP_IoT/backend/src/services/serialService.js)
- **Command Acknowledgement Registry**: Add support in `sendSerialCommand` to return a Promise that resolves when an `ack` payload from the serial port is received (with a 2-second timeout).
- **Cloud Mode Simulation**: Resolve immediately if running in Cloud mode (`IS_EDGE_GATEWAY !== 'true'`) to prevent errors during remote testing/deployment.

#### [MODIFY] [db.js](file:///G:/REP_IoT/backend/src/config/db.js)
- **Disable Mock DB for Production**: Throw an error and crash/exit the process if MySQL database credentials are unset/placeholder and `NODE_ENV === 'production'`. This prevents silent fallback to an in-memory database in live deployments.

#### [MODIFY] [oeeCalculator.js](file:///G:/REP_IoT/backend/src/services/oeeCalculator.js)
- **Optimize OEE Calculations**: Replace loading all today's pulses in JavaScript with database-level aggregation queries for shift-wise counts. Keep the in-memory fallback for mock mode to preserve testing compatibility.

#### [NEW] [watchdogService.js](file:///G:/REP_IoT/backend/src/services/watchdogService.js)
- **Stale Pulse Watchdog**: Implement a background service checking running machines every 10 seconds. If `now - last_pulse` exceeds `Math.max(ideal_cycle_time * 5, 120)` seconds, transition the machine to `Stopped` via `handleStatusMessage`.

#### [MODIFY] [server.js](file:///G:/REP_IoT/backend/src/server.js)
- **Start Watchdog**: Initialize the watchdog service on server boot.

---

### Component: Firmware

#### [MODIFY] [esp32_cnc_monitor.ino](file:///G:/REP_IoT/firmware/esp32_cnc_monitor.ino)
- **Safety Pin Assignment**: Change `PIN_RUN_ENABLE` from GPIO 12 (strapping pin) to a safe pin (GPIO 27) to avoid boot issues.
- **Command Acknowledgement**: Output JSON formatted `ack` payload over serial upon processing `resume` and `stop` control commands.
- **Cycle Timer Reset**: Reset `lastCycleStart = millis()` upon receiving a `resume` command or when `PIN_STATUS` transitions to HIGH to avoid incorrect cycle times.
- **Ignored Overwrites**: Ensure that status reporting respects `PIN_RUN_ENABLE` state (if interlock is disabled/LOW, report status as `Stopped` to prevent green stack-lights from immediately overwriting touchscreen Stop commands).

---

## Verification Plan

### Automated Tests
- Build and run the backend locally with real database configuration.
- Verify production build of frontend still succeeds: `npm run build` inside `frontend`.

### Manual Verification
- **Terminal Crash**: Navigate to operator login view and verify no ReferenceError crashes occur.
- **Dynamic URLs**: Verify frontend loaded from `http://localhost:5000` contacts localhost, and when built for prod automatically uses host origin.
- **Stop/Resume Confirmations**: Trigger Stop/Resume from UI and ensure they await ESP32 ack, failing gracefully if timeout occurs.
- **Mock DB Lockout**: Run backend with `NODE_ENV=production` and mock credentials; verify server crashes on startup.
- **Watchdog**: Set machine to Running, wait for timeout, and check if status transitions to Stopped automatically.
