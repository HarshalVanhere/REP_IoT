# Implementation Tasks

- [x] **Frontend Fixes**
  - [x] Fix Operator Terminal ReferenceError crash ([OperatorTerminal.jsx](file:///G:/REP_IoT/frontend/src/components/OperatorTerminal.jsx))
  - [x] Support `SYNC_UPDATE` events in [App.jsx](file:///G:/REP_IoT/frontend/src/App.jsx)
  - [x] Configure dynamic local backend/WS address in [.env](file:///G:/REP_IoT/frontend/.env) and [.env.example](file:///G:/REP_IoT/frontend/.env.example)

- [x] **Backend Refactoring**
  - [x] Refactor `/stop` and `/resume` to wait for serial confirmation ([api.js](file:///G:/REP_IoT/backend/src/routes/api.js))
  - [x] Attach latest machine counts in `SYNC_UPDATE` WS message ([api.js](file:///G:/REP_IoT/backend/src/routes/api.js))
  - [x] Implement promise-based command-ack registry in [serialService.js](file:///G:/REP_IoT/backend/src/services/serialService.js)
  - [x] Enforce database connection and disable mock database fallback in production mode ([db.js](file:///G:/REP_IoT/backend/src/config/db.js))
  - [x] Optimize OEE calculations with database-level aggregates ([oeeCalculator.js](file:///G:/REP_IoT/backend/src/services/oeeCalculator.js))
  - [x] Implement and integrate background stale-pulse watchdog service ([watchdogService.js](file:///G:/REP_IoT/backend/src/services/watchdogService.js), [server.js](file:///G:/REP_IoT/backend/src/server.js))

- [x] **Firmware Updates**
  - [x] Move interlock relay pin to safe GPIO 27 in [esp32_cnc_monitor.ino](file:///G:/REP_IoT/firmware/esp32_cnc_monitor.ino)
  - [x] Emit JSON `ack` responses over serial for control commands
  - [x] Reset cycle start timer on resume/start transitions
  - [x] Respect interlock state to prevent Running state overwrites

- [x] **Verification**
  - [x] Build and verify frontend production build
  - [x] Verify backend launches successfully in production and development configurations
  - [x] Walkthrough documentation
