import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { logger } from '../utils/logger.js';

dotenv.config();

let pool = null;
let isMock = false;

// CRITICAL FIX: a connection failure at boot used to leave isMock permanently true for the
// rest of the process's life - nothing ever attempted to reconnect, and even a manual fix
// wouldn't have been visible to callers (see the `db.isMock` getter further down). These two
// flags back a background self-healing retry loop: `reconnecting` prevents two retry attempts
// from overlapping if a slow connection attempt is still in flight when the next tick fires,
// and `reconnectTimer` lets that loop be cancelled once a real connection is restored.
let reconnecting = false;
let reconnectTimer = null;
const RECONNECT_INTERVAL_MS = 30000;

// Default seed password for demo/first-boot accounts. Must be changed via
// POST /api/auth/change-password before real deployment.
const DEFAULT_SEED_PASSWORD_HASH = bcrypt.hashSync('1234', 10);

// Mock database storage in case MySQL is unavailable (IDs updated to match names)
const mockDb = {
  machines: [
    { id: '1302', name: '1302 DOOSAN CNC LYNX 220', status: 'Running', target: 300, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 20, last_pulse: null, active_part_name: 'Pinion Gear', assigned_operator: 'OP-101' },
    { id: '1306', name: '1306 ACE CNC SUPER JOBBER', status: 'Running', target: 150, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 45, last_pulse: null, active_part_name: 'Turbine Blade', assigned_operator: 'OP-101' },
    { id: '1308', name: '1308 ACE CNC SUPER JOBBER', status: 'Running', target: 400, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 15, last_pulse: null, active_part_name: 'Collar Bushing', assigned_operator: 'OP-102' },
    { id: '1309', name: '1309 ACE CNC SUPER JOBBER', status: 'Running', target: 500, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 12, last_pulse: null, active_part_name: 'Drive Shaft', assigned_operator: 'OP-102' },
    { id: '1310', name: '1310 ACE CNC SUPER JOBBER', status: 'Running', target: 800, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 8, last_pulse: null, active_part_name: 'Mounting Plate', assigned_operator: 'OP-103' },
    { id: '1311', name: '1311 VERTICAL TRIMMING MACHINE', status: 'Running', target: 600, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 10, last_pulse: null, active_part_name: 'Enclosure Panel', assigned_operator: 'OP-103' },
    { id: '1312', name: '1312 ACE CNC SUPER JOBBER', status: 'Stopped', target: 250, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 25, last_pulse: null, active_part_name: 'Crankshaft Pin', assigned_operator: 'OP-101' },
    { id: '1313', name: '1313 ACE CNC SUPER JOBBER', status: 'Running', target: 500, production_count: 0, good_count: 0, scrap_count: 0, ideal_cycle_time: 12, last_pulse: null, active_part_name: 'Flange Hanger', assigned_operator: 'OP-104' }
  ],
  pulses: [],
  status_logs: [],
  users: [],
  audit_log: [],
  shift_plans: [],
  production_records: [],
  part_schedules: []
};

// All seeded demo machines are treated as already physically wired up (iot_enabled = true) so
// the existing mock-mode live/report demo data keeps working unchanged - a newly Admin-created
// machine defaults iot_enabled = false (see partMaster/machines POST route) until connected.
mockDb.machines.forEach((m) => { m.segment_start = new Date(); m.active_schedule_id = null; m.last_manual_reset_at = null; m.last_cycle_reset_at = null; m.iot_enabled = true; m.heartbeat_timeout_seconds = 120; m.last_heartbeat = null; });

let mockPulseId = 1;
let mockLogId = 1;
let mockAuditId = 1;
let mockShiftPlanId = 1;
let mockProductionRecordId = 1;
let mockPartScheduleId = 1;

// Seed rich mock data
function seedMockData() {
  const now = new Date();
  
  // 1. Initialize users (default password for all seed accounts is "1234" - change on first login)
  mockDb.users = [
    { loginId: 'SUP-201', role: 'Supervisor', displayName: 'Supervisor User', terminalId: 'DASHBOARD', password_hash: DEFAULT_SEED_PASSWORD_HASH },
    { loginId: 'PPC-301', role: 'PPC Engineer', displayName: 'PPC Engineer', terminalId: 'PLANNING-BOARD', password_hash: DEFAULT_SEED_PASSWORD_HASH },
    { loginId: 'ADMIN', role: 'Admin', displayName: 'Admin User', terminalId: 'CONTROL-ROOM', password_hash: DEFAULT_SEED_PASSWORD_HASH },
    // Demo operator roster for the Supervisor Operator Assignment screen in mock/dev mode only -
    // a real deployment's operators are created by an Admin via User Profiles, not seeded here.
    { loginId: 'OP-101', role: 'Operator', displayName: 'Harsh', terminalId: 'DASHBOARD', password_hash: DEFAULT_SEED_PASSWORD_HASH },
    { loginId: 'OP-102', role: 'Operator', displayName: 'Suresh', terminalId: 'DASHBOARD', password_hash: DEFAULT_SEED_PASSWORD_HASH },
    { loginId: 'OP-103', role: 'Operator', displayName: 'Rahul', terminalId: 'DASHBOARD', password_hash: DEFAULT_SEED_PASSWORD_HASH },
    { loginId: 'OP-104', role: 'Operator', displayName: 'Amit', terminalId: 'DASHBOARD', password_hash: DEFAULT_SEED_PASSWORD_HASH }
  ];

  // 2. Generate completed downtime logs (Stopped status) to populate charts
  const downtimeReasons = [
    'Tea Break',
    'Lunch Break',
    'Tool Wear / Replacement',
    'Measure and Adjustment',
    'No Power',
    'Material Shortage',
    'Mechanical Jam / Fault',
    'Machine Breakdown',
    'Setup / Calibration',
    'Preventive Maintenance (PM)'
  ];
  
  const machinesList = ['1302', '1306', '1308', '1309', '1310', '1311', '1312', '1313'];
  
  // Seed past completed running/stopping cycles
  machinesList.forEach((mId, mIdx) => {
    // Generate 3 completed downtime logs for each machine in the last 24 hours
    for (let i = 0; i < 3; i++) {
      const startTime = new Date(now.getTime() - (24 - i * 8) * 60 * 60 * 1000);
      const stopDuration = 20 + Math.floor(Math.random() * 40); // 20-60 mins
      const endTime = new Date(startTime.getTime() + stopDuration * 60 * 1000);
      
      // Stop Log
      mockDb.status_logs.push({
        id: mockLogId++,
        machine_id: mId,
        status: 'Stopped',
        start_time: startTime,
        end_time: endTime,
        downtime_reason: downtimeReasons[Math.floor(Math.random() * downtimeReasons.length)],
        operator_id: `OP-10${(mIdx % 3) + 1}`,
        part_name: 'Pinion Gear'
      });
      
      // Running Log after stop
      const runDuration = 120 + Math.floor(Math.random() * 180); // 2-5 hours
      const runStartTime = endTime;
      const runEndTime = new Date(runStartTime.getTime() + runDuration * 60 * 1000);
      
      mockDb.status_logs.push({
        id: mockLogId++,
        machine_id: mId,
        status: 'Running',
        start_time: runStartTime,
        end_time: runEndTime < now ? runEndTime : null,
        downtime_reason: null,
        operator_id: `OP-10${(mIdx % 3) + 1}`,
        part_name: 'Pinion Gear'
      });
    }
  });
  
  // 3. Generate initial pulses in the last 12 hours for OEE and production tally
  machinesList.forEach((mId) => {
    const numPulses = 40 + Math.floor(Math.random() * 40);
    const idealCycleTime = mId === '1306' ? 45 : mId === '1310' ? 8 : 15;
    
    for (let i = 0; i < numPulses; i++) {
      const pulseTime = new Date(now.getTime() - (12 * 60 * 60 * 1000) + (i * 10 * 60 * 1000));
      const cycleTime = parseFloat((idealCycleTime + (Math.random() * 4 - 2)).toFixed(2));
      const isGood = Math.random() > 0.03; // 97% good yield
      
      mockDb.pulses.push({
        id: mockPulseId++,
        machine_id: mId,
        timestamp: pulseTime,
        cycle_time: cycleTime,
        is_good: isGood ? 1 : 0
      });
    }
  });

  // Calculate and sync initial machine states
  mockDb.machines.forEach(machine => {
    const machinePulses = mockDb.pulses.filter(p => p.machine_id === machine.id);
    machine.production_count = machinePulses.length;
    machine.good_count = machinePulses.filter(p => p.is_good === 1).length;
    machine.scrap_count = machine.production_count - machine.good_count;
    
    // Set OEE metrics
    const availability = 70 + Math.floor(Math.random() * 20);
    const performance = 65 + Math.floor(Math.random() * 25);
    const quality = 96 + Math.floor(Math.random() * 3);
    const oee = Math.round((availability * performance * quality) / 10000);
    
    machine.metrics = {
      oee,
      availability,
      performance,
      quality,
      currentShift: 'Shift A',
      shifts: {
        A: Math.round(machine.production_count * 0.5),
        B: Math.round(machine.production_count * 0.3),
        C: Math.round(machine.production_count * 0.2)
      },
      utilization: {
        Running: availability,
        Stopped: 100 - availability - 2,
        NoSignal: 2
      },
      downtimeReasons: {
        'Tea Break': 1800,
        'Lunch Break': 3600,
        'Tool Wear / Replacement': 900,
        'Material Shortage': 1200
      }
    };
  });
  
  console.log(`✅ Seeded mock database: ${mockDb.pulses.length} pulses, ${mockDb.status_logs.length} downtime cycles.`);
}

const connectionConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'cnc_dashboard',
  // Return DATE columns (e.g. shift_plans.plan_date) as plain 'YYYY-MM-DD' strings instead
  // of Date objects - avoids UTC-midnight timezone drift when comparing dates as strings.
  // Scoped to DATE only so existing TIMESTAMP columns (last_pulse, start_time, etc.) are unaffected.
  dateStrings: ['DATE'],
  // CRITICAL FIX: without this, mysql2 converts JS Date <-> TIMESTAMP columns using whatever
  // timezone the Node process's OS happens to be set to, while the MySQL server session
  // converts them using its OWN timezone (often UTC on a cloud host). If those two disagree,
  // every write/read round-trip silently shifts by the difference - this is what produced
  // status_logs timestamps hours ahead of the plant's live clock (e.g. Aug 13 15:21 shown while
  // the live clock read 11:45, a ~5:30 gap matching IST). Pinning both sides to UTC (this option
  // plus the `SET time_zone` on every new connection below) makes every stored instant
  // unambiguous regardless of server OS config - shifts.js's PLANT_TIMEZONE conversion for
  // wall-clock display is the only place local time should ever be reconstructed.
  timezone: 'Z',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const isProduction = process.env.NODE_ENV === 'production';

// Hoisted out of the boot-time try/catch below so the background reconnect loop (see
// scheduleReconnectAttempts()) can call the exact same connect-and-migrate logic again later,
// instead of duplicating it. Every statement in here is already idempotent (CREATE TABLE IF NOT
// EXISTS, ALTER TABLE wrapped in try/catch-ignore, migrations guarded by a COUNT(*) === 0 check)
// so re-running it on a later successful reconnect is always safe, not just at first boot.
async function connectAndSetupRealDatabase() {
  pool = mysql.createPool(connectionConfig);
  // Belt-and-braces alongside `timezone: 'Z'` above: forces every physical connection's MySQL
  // SESSION time_zone to UTC too, so a server whose global/system time_zone isn't UTC can't
  // reintroduce the same double-conversion drift this was meant to fix.
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  const conn = await pool.getConnection();
  console.log('✅ Connected to MySQL successfully.');
  conn.release();

  // Create users table and seed initial users in MySQL if empty
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        loginId VARCHAR(50) PRIMARY KEY,
        role VARCHAR(50) NOT NULL,
        displayName VARCHAR(100) NOT NULL,
        terminalId VARCHAR(50) NOT NULL,
        password_hash VARCHAR(100) NOT NULL DEFAULT ''
      )
    `);
    // Upgrade path for pre-existing deployments created before password_hash existed
    try {
      await pool.query("ALTER TABLE users ADD COLUMN password_hash VARCHAR(100) NOT NULL DEFAULT ''");
      console.log('   + Added "password_hash" column to users table');
    } catch (err) {
      // Ignore if column already exists
    }
    
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM users');
    if (rows[0].count === 0) {
      await pool.query(`
        INSERT INTO users (loginId, role, displayName, terminalId, password_hash) VALUES
        ('SUP-201', 'Supervisor', 'Supervisor User', 'DASHBOARD', ?),
        ('PPC-301', 'PPC Engineer', 'PPC Engineer', 'PLANNING-BOARD', ?),
        ('ADMIN', 'Admin', 'Admin User', 'CONTROL-ROOM', ?)
      `, [DEFAULT_SEED_PASSWORD_HASH, DEFAULT_SEED_PASSWORD_HASH, DEFAULT_SEED_PASSWORD_HASH]);
      console.log('✅ Seeded users table in MySQL (default password: 1234 - change before go-live).');
    } else {
      // Backfill any existing rows that predate password_hash (upgrade path)
      await pool.query("UPDATE users SET password_hash = ? WHERE password_hash = '' OR password_hash IS NULL", [DEFAULT_SEED_PASSWORD_HASH]);
    }

    // Create audit_log table for tracking sensitive actions (login, user/machine CRUD, stop/resume, planning changes)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actor_login_id VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        target VARCHAR(100) NULL,
        details VARCHAR(500) NULL
      )
    `);

    // Create shift_plans table for dated PPC shift scheduling
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shift_plans (
        id INT AUTO_INCREMENT PRIMARY KEY,
        machine_id VARCHAR(50) NOT NULL,
        plan_date DATE NOT NULL,
        shift VARCHAR(10) NOT NULL,
        target INT NOT NULL,
        ideal_cycle_time INT NOT NULL,
        part_name VARCHAR(100) NULL,
        operator VARCHAR(100) NULL,
        created_by VARCHAR(50) NULL,
        updated_by VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_machine_date_shift (machine_id, plan_date, shift),
        FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
      )
    `);

    // Create production_records table: a permanent snapshot of each part/shift run's counts,
    // written just before the live counters on `machines` are reset to 0 (shift change, part
    // change, or a manual Supervisor/Admin reset). Nothing is ever deleted here - this is the
    // append-only history that the live production_count/good_count/scrap_count columns lose.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS production_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        machine_id VARCHAR(50) NOT NULL,
        part_name VARCHAR(100) NULL,
        operator VARCHAR(100) NULL,
        shift VARCHAR(10) NULL,
        target INT NOT NULL DEFAULT 0,
        production_count INT NOT NULL DEFAULT 0,
        good_count INT NOT NULL DEFAULT 0,
        scrap_count INT NOT NULL DEFAULT 0,
        reset_reason VARCHAR(50) NOT NULL,
        reset_by VARCHAR(50) NULL,
        start_time TIMESTAMP NULL,
        end_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
      )
    `);

    // Tracks when the current live-count segment started, so production_records can log an
    // accurate start_time for each closed-out run.
    try {
      await pool.query('ALTER TABLE machines ADD COLUMN segment_start TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
      console.log('   + Added "segment_start" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }

    // Create part_schedules table: an ordered, unlimited-length list of parts a machine runs
    // sequentially within one shift (replaces shift_plans, which only allowed one part per
    // shift). `sequence` determines run order; `status` is written by the watchdog/manual
    // override, never derived client-side, so the Planning Board's badges can never drift
    // from what actually happened.
    console.log('🛠️  Creating "part_schedules" table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS part_schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        machine_id VARCHAR(50) NOT NULL,
        plan_date DATE NOT NULL,
        shift VARCHAR(10) NOT NULL,
        sequence INT NOT NULL,
        part_name VARCHAR(100) NOT NULL,
        target INT NOT NULL,
        ideal_cycle_time INT NOT NULL,
        operator VARCHAR(100) NULL,
        planned_start TIME NOT NULL,
        planned_end TIME NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'Pending',
        activated_at TIMESTAMP NULL,
        completed_at TIMESTAMP NULL,
        created_by VARCHAR(50) NULL,
        updated_by VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_machine_date_shift_seq (machine_id, plan_date, shift, sequence),
        FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
      )
    `);

    // Points from the live machine row to whichever part_schedules entry is currently active,
    // so the watchdog/override logic knows what to close out and pulses know what to stamp.
    try {
      await pool.query('ALTER TABLE machines ADD COLUMN active_schedule_id INT NULL');
      console.log('   + Added "active_schedule_id" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }

    // Timestamp of the last Supervisor/Admin manual counter reset. The edge gateway's
    // pullMachineConfig compares this against its own locally-recorded value so a reset
    // triggered from the cloud dashboard also propagates down to the machine's own counters -
    // otherwise a cloud-side reset only ever affects the cloud's mirror of the count, since
    // the gateway (not the cloud) is what actually increments counts live off real pulses.
    try {
      await pool.query('ALTER TABLE machines ADD COLUMN last_manual_reset_at TIMESTAMP NULL');
      console.log('   + Added "last_manual_reset_at" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }

    // Stamped every time a machine transitions to Stopped (operator-pressed Stop, or the
    // watchdog's no-pulse-for-ideal-cycle+2min auto-stop) - see handleStatusMessage(). Lets
    // calculateOEE() ignore pulses from before the stop when reporting "last cycle time", so a
    // long-stale cycle time from before a long Stop doesn't keep showing after Resume.
    try {
      await pool.query('ALTER TABLE machines ADD COLUMN last_cycle_reset_at TIMESTAMP NULL');
      console.log('   + Added "last_cycle_reset_at" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }

    // Stamped at ingest time (not derived via a time-window join) so per-part production
    // stays correct even when a manual override or a forced end-time cutover makes actual
    // execution diverge from the planned start/end window.
    try {
      await pool.query('ALTER TABLE pulses ADD COLUMN part_schedule_id INT NULL');
      console.log('   + Added "part_schedule_id" column to pulses table');
    } catch (err) {
      // Ignore if column already exists
    }

    // Connectivity: iot_enabled marks a machine as physically wired to an ESP32/Raspberry Pi.
    // A machine with iot_enabled = FALSE never receives real pulses/status - it must always
    // read "Not Connected", never a fabricated Running/Stopped/OEE state. heartbeat_timeout_seconds
    // is the per-machine override for how long a *connected* machine can go without a pulse
    // before the watchdog also declares it Not Connected.
    try {
      await pool.query('ALTER TABLE machines ADD COLUMN iot_enabled BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('   + Added "iot_enabled" column to machines table');
      // One-time backfill: every machine that already existed before this column was added was
      // already being treated as physically connected (there was no "Not Connected" registration
      // concept before this feature) - only brand-new machines created from here on should
      // default to FALSE until an Admin confirms the physical IoT wiring. Only runs the tick this
      // ALTER actually adds the column (guarded by the same try/catch), never again afterward.
      await pool.query('UPDATE machines SET iot_enabled = TRUE');
      console.log('   + Backfilled "iot_enabled" = TRUE on all pre-existing machines');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await pool.query('ALTER TABLE machines ADD COLUMN heartbeat_timeout_seconds INT NOT NULL DEFAULT 120');
      console.log('   + Added "heartbeat_timeout_seconds" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }
    // Last time this machine's ESP32 sent a liveness heartbeat (see handleHeartbeatMessage in
    // mqttService.js) - separate from last_pulse, which only advances on a finished production
    // cycle. This is now the sole signal watchdogService.js's edge-gateway connectivity check
    // uses; last_pulse remains purely a production-tracking field.
    try {
      await pool.query('ALTER TABLE machines ADD COLUMN last_heartbeat TIMESTAMP NULL');
      console.log('   + Added "last_heartbeat" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }

    // production_records doubles as both the counter-close-out history (existing purpose)
    // and the part-change audit trail (previous/next part, who changed it, why) - one table
    // instead of two that could drift out of sync with each other.
    const productionRecordAuditColumns = [
      ['schedule_id', 'INT NULL'],
      ['previous_part_name', 'VARCHAR(100) NULL'],
      ['next_part_name', 'VARCHAR(100) NULL'],
      ['changed_by', 'VARCHAR(50) NULL'],
      ['change_trigger', 'VARCHAR(30) NULL'],
      ['change_reason', 'VARCHAR(255) NULL']
    ];
    for (const [column, definition] of productionRecordAuditColumns) {
      try {
        await pool.query(`ALTER TABLE production_records ADD COLUMN ${column} ${definition}`);
        console.log(`   + Added "${column}" column to production_records table`);
      } catch (err) {
        // Ignore if column already exists
      }
    }

    // No Part Master catalog and no Admin-configured default allowance - see the matching
    // comment in db-setup.js. The PPC Engineer types Part Number, Part Name, Part Operation,
    // Ideal Cycle Time, and the Loading/Unloading Allowance directly on every schedule entry.
    const partScheduleManualEntryColumns = [
      ['part_number', 'VARCHAR(50) NULL'],
      ['part_operation', 'VARCHAR(150) NULL'],
      ['load_unload_allowance_seconds', 'INT NULL']
    ];
    for (const [column, definition] of partScheduleManualEntryColumns) {
      try {
        await pool.query(`ALTER TABLE part_schedules ADD COLUMN ${column} ${definition}`);
        console.log(`   + Added "${column}" column to part_schedules table`);
      } catch (err) {
        // Ignore if column already exists
      }
    }

    // One-off migration: carry forward any current/future shift_plans rows into part_schedules
    // as a single sequence-1 entry, so existing PPC-entered plans aren't lost when the planning
    // module switches to the multi-part model. Guarded so it only ever runs once.
    try {
      const [existingSchedules] = await pool.query('SELECT COUNT(*) as count FROM part_schedules');
      if (existingSchedules[0].count === 0) {
        const { toDateOnlyString } = await import('./shifts.js');
        const today = toDateOnlyString();
        const [legacyPlans] = await pool.query('SELECT * FROM shift_plans WHERE plan_date >= ?', [today]);

        const shiftWindowMinutes = {
          'Shift A': { start: 7 * 60, end: 15.5 * 60 },
          'Shift B': { start: 15.5 * 60, end: 24 * 60 },
          'Shift C': { start: 0, end: 7 * 60 }
        };
        const toTimeString = (minutes) => {
          const m = minutes % (24 * 60);
          const hh = String(Math.floor(m / 60)).padStart(2, '0');
          const mm = String(Math.round(m % 60)).padStart(2, '0');
          return `${hh}:${mm}:00`;
        };

        for (const plan of legacyPlans) {
          const window = shiftWindowMinutes[plan.shift] || shiftWindowMinutes['Shift A'];
          const [machineRows] = await pool.query('SELECT active_part_name FROM machines WHERE id = ?', [plan.machine_id]);
          const isCurrentlyActive = machineRows.length > 0 && machineRows[0].active_part_name === (plan.part_name || 'Unassigned');

          const [insertResult] = await pool.query(
            `INSERT INTO part_schedules
              (machine_id, plan_date, shift, sequence, part_name, target, ideal_cycle_time, operator, planned_start, planned_end, status, activated_at, created_by, updated_by)
             VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              plan.machine_id, plan.plan_date, plan.shift, plan.part_name || 'Unassigned', plan.target, plan.ideal_cycle_time,
              plan.operator || 'Unassigned', toTimeString(window.start), toTimeString(window.end),
              isCurrentlyActive ? 'Running' : 'Pending', isCurrentlyActive ? new Date() : null,
              plan.created_by, plan.updated_by
            ]
          );

          if (isCurrentlyActive) {
            await pool.query('UPDATE machines SET active_schedule_id = ? WHERE id = ?', [insertResult.insertId, plan.machine_id]);
          }
        }
        if (legacyPlans.length > 0) {
          console.log(`   + Migrated ${legacyPlans.length} shift_plans row(s) into part_schedules`);
        }
      }
    } catch (err) {
      console.warn('⚠️  shift_plans -> part_schedules migration skipped:', err.message);
    }

    // PERMANENT FIX for the recurring duplicate/open status_logs rows bug (see a6d01ef..a2e0410):
    // every previous attempt added another withMachineLock() call around another individual
    // writer, but that lock is an in-memory Map scoped to THIS process (see machineLock.js) - it
    // cannot stop two different processes (e.g. this server after a restart/redeploy racing its
    // own previous instance mid-shutdown, or any future second instance) from both seeing "no
    // open row" and both inserting one. That's a check-then-act race no amount of application
    // locking closes; only a database constraint can. This makes "more than one open status log
    // per machine" structurally impossible at the DB level, so every writer's SELECT-then-INSERT
    // becomes an optimization rather than the actual source of truth.
    try {
      // 1. Clean up any duplicate open rows that already exist (e.g. from before this fix) -
      // the unique index below will fail to create otherwise. Keep the earliest (lowest id) open
      // row per machine, close the rest out at their own start_time (0-duration, clearly a
      // cleanup artifact rather than a fabricated real duration).
      const [dupeMachines] = await pool.query(`
        SELECT machine_id FROM status_logs
        WHERE end_time IS NULL
        GROUP BY machine_id
        HAVING COUNT(*) > 1
      `);
      for (const { machine_id } of dupeMachines) {
        const [openRows] = await pool.query(
          'SELECT id, start_time FROM status_logs WHERE machine_id = ? AND end_time IS NULL ORDER BY id ASC',
          [machine_id]
        );
        for (let i = 1; i < openRows.length; i++) {
          await pool.query(
            'UPDATE status_logs SET end_time = ?, synced = FALSE WHERE id = ?',
            [openRows[i].start_time, openRows[i].id]
          );
        }
      }
      if (dupeMachines.length > 0) {
        console.log(`   + Cleaned up duplicate open status_logs rows for ${dupeMachines.length} machine(s)`);
      }
    } catch (err) {
      console.warn('⚠️  status_logs duplicate cleanup skipped:', err.message);
    }
    try {
      // 2. A generated column that is 1 while a row is open (end_time IS NULL) and NULL once
      // closed. MySQL unique indexes treat NULL as "no value to compare" (multiple NULLs never
      // conflict), so this only ever constrains the OPEN rows - exactly the invariant every
      // status_logs writer already assumes ("at most one open row per machine") but never had
      // enforced.
      await pool.query(
        'ALTER TABLE status_logs ADD COLUMN is_open TINYINT GENERATED ALWAYS AS (IF(end_time IS NULL, 1, NULL)) STORED'
      );
      console.log('   + Added "is_open" generated column to status_logs table');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await pool.query(
        'ALTER TABLE status_logs ADD UNIQUE KEY uniq_status_logs_open_machine (machine_id, is_open)'
      );
      console.log('   + Added unique constraint enforcing one open status log per machine');
    } catch (err) {
      // Ignore if constraint already exists (or, if duplicates were re-introduced since the
      // cleanup above ran on some earlier boot, log it loudly since it means the invariant is
      // still being violated somewhere upstream)
      if (!/duplicate/i.test(err.message)) {
        console.warn('⚠️  status_logs unique-open-row constraint not applied:', err.message);
      }
    }
}

// Background self-healing loop for the case where `connectAndSetupRealDatabase()` fails at
// boot (transient network blip, DB not accepting connections yet, etc.) and the process has
// fallen back to mock mode below. Without this, `isMock` stayed true for the rest of the
// process's life - a real production incident this fixes, not a hypothetical one.
async function attemptReconnect() {
  if (reconnecting) return; // a previous attempt is still in flight - never overlap retries
  reconnecting = true;
  try {
    await connectAndSetupRealDatabase();
    isMock = false;
    console.log('✅ Recovered: MySQL connection re-established, resuming real database mode.');
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  } catch (err) {
    // Still down - leave isMock as-is and let the next scheduled tick try again. Reset `pool`
    // in case createPool() partially succeeded before the failure, so a stale/broken pool is
    // never left reachable through db.getPool()/db.query() while isMock is still true.
    pool = null;
    console.warn(`⚠️  Reconnect attempt to MySQL failed, still in mock mode: ${err.message}`);
  } finally {
    reconnecting = false;
  }
}

function scheduleReconnectAttempts() {
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setInterval(attemptReconnect, RECONNECT_INTERVAL_MS);
}

try {
  if (process.env.DB_PASSWORD === 'your_mysql_password' || !process.env.DB_PASSWORD) {
    if (isProduction) {
      throw new Error('Database password is unset or placeholder. Database connection is required in production mode.');
    }
    console.warn('⚠️  Database password is unset or placeholder. Falling back to IN-MEMORY MOCK database mode.');
    isMock = true;
    seedMockData();
    // Deliberately NOT scheduling a reconnect loop here: an unset/placeholder password is a
    // configuration problem, not a transient outage - it cannot self-resolve without an env
    // change and a restart, and retrying would just re-seed mock data on a timer for no benefit.
  } else {
    await connectAndSetupRealDatabase();
  }
} catch (error) {
  if (isProduction) {
    console.error('❌ Production Error: Failed to connect to MySQL database:', error.message);
    process.exit(1);
  }
  console.warn('⚠️  Could not connect to MySQL database. Details:', error.message);
  isMock = true;
  pool = null;
  seedMockData();
  scheduleReconnectAttempts();
}

// Simple query simulator for in-memory mode
async function mockQuery(sql, params = []) {
  const normalizedSql = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  const sqlLower = sql.toLowerCase();

  // 1. SELECT FROM machines
  if (normalizedSql.includes('from machines')) {
    let filtered = [...mockDb.machines];
    if (normalizedSql.includes('where id = ?')) {
      const mId = params[0];
      filtered = filtered.filter(m => m.id === mId);
    }
    // Watchdog's per-tick connectivity enforcement query - machines with no ESP32/Pi wired up
    // (iot_enabled false) that aren't already showing Not Connected.
    if (normalizedSql.includes('iot_enabled = false')) {
      filtered = filtered.filter(m => !m.iot_enabled);
      if (normalizedSql.includes("status != 'not connected'")) {
        filtered = filtered.filter(m => m.status !== 'Not Connected');
      }
    }
    return [JSON.parse(JSON.stringify(filtered)), []];
  }

  // 2. SELECT FROM pulses
  if (normalizedSql.includes('from pulses')) {
    let filtered = [...mockDb.pulses];
    if (normalizedSql.includes('where machine_id = ?')) {
      const mId = params[0];
      filtered = filtered.filter(p => p.machine_id === mId);
    }
    if (normalizedSql.includes('where part_schedule_id = ?')) {
      const scheduleId = params[0];
      filtered = filtered.filter(p => p.part_schedule_id === scheduleId);
    }
    if (normalizedSql.includes('timestamp >= ?') || normalizedSql.includes('timestamp >=?')) {
      const minDate = params[1];
      filtered = filtered.filter(p => new Date(p.timestamp) >= new Date(minDate));
    }
    if (normalizedSql.includes('limit ?')) {
      const limit = params[params.length - 1];
      filtered = filtered.slice(-limit);
      filtered.reverse(); 
    }
    return [JSON.parse(JSON.stringify(filtered)), []];
  }

  // 3. SELECT FROM status_logs
  if (normalizedSql.includes('from status_logs')) {
    let filtered = [...mockDb.status_logs];
    if (normalizedSql.includes('where machine_id = ?')) {
      const mId = params[0];
      filtered = filtered.filter(l => l.machine_id === mId);
    }
    if (normalizedSql.includes('end_time is null')) {
      filtered = filtered.filter(l => l.end_time === null);
    }
    if (normalizedSql.includes('end_time >= ?') || normalizedSql.includes('end_time >=?')) {
      const minDate = params[1];
      filtered = filtered.filter(l => l.end_time === null || new Date(l.end_time) >= new Date(minDate));
    }
    const enriched = filtered.map(log => {
      const machine = mockDb.machines.find(m => m.id === log.machine_id);
      return {
        ...log,
        machine_name: machine ? machine.name : log.machine_id,
        machine_section: 'General',
        part_name: log.part_name || (machine ? machine.active_part_name : null)
      };
    });
    return [JSON.parse(JSON.stringify(enriched)), []];
  }

  // 4. INSERT INTO pulses
  if (normalizedSql.startsWith('insert into pulses')) {
    const colMatch = sql.match(/\(([^)]+)\)/);
    const columns = colMatch ? colMatch[1].split(',').map(c => c.trim().toLowerCase()) : [];
    const pulse = {
      id: mockPulseId++,
      machine_id: params[0],
      timestamp: params[1] || new Date(),
      cycle_time: parseFloat(params[2] || 0),
      is_good: params[3] !== undefined ? params[3] : true,
      part_schedule_id: columns.includes('part_schedule_id') ? params[columns.indexOf('part_schedule_id')] : null
    };
    mockDb.pulses.push(pulse);
    return [{ insertId: pulse.id, affectedRows: 1 }, []];
  }

  // 5. UPDATE status_logs
  if (sqlLower.startsWith('update status_logs')) {
    let affectedRows = 0;
    // Bulk-close every open log for a machine (WHERE machine_id = ? AND end_time IS NULL) -
    // used to guarantee no stray duplicate open rows are ever left behind, vs. the legacy
    // close-by-specific-id pattern below.
    const closesByMachine = sqlLower.includes('where machine_id = ?') && sqlLower.includes('end_time is null');

    if (sqlLower.includes('downtime_reason = ?') || sqlLower.includes('downtime_reason=?')) {
      const [endTime, reason, target] = params;
      mockDb.status_logs.forEach(log => {
        const matches = closesByMachine ? (log.machine_id === target && log.end_time === null) : (log.id === target);
        if (matches) {
          log.end_time = endTime;
          log.downtime_reason = reason;
          affectedRows++;
        }
      });
    } else {
      const [endTime, target] = params;
      mockDb.status_logs.forEach(log => {
        const matches = closesByMachine ? (log.machine_id === target && log.end_time === null) : (log.id === target);
        if (matches) {
          log.end_time = endTime;
          affectedRows++;
        }
      });
    }
    return [{ affectedRows }, []];
  }

  // 6. INSERT INTO status_logs
  if (sqlLower.startsWith('insert into status_logs')) {
    const colMatch = sql.match(/\(([^)]+)\)/);
    let columns = [];
    if (colMatch) {
      columns = colMatch[1].split(',').map(c => c.trim().toLowerCase());
    }

    const valMatch = sql.match(/values\s*\(([^)]+)\)/i);
    let valStrings = [];
    if (valMatch) {
      valStrings = valMatch[1].split(',').map(v => v.trim());
    }

    const log = {
      id: mockLogId++,
      machine_id: '',
      status: '',
      start_time: new Date(),
      end_time: null,
      downtime_reason: null,
      operator_id: null,
      part_name: null
    };

    let paramIndex = 0;
    columns.forEach((col, idx) => {
      const valStr = valStrings[idx];
      let value = null;
      if (valStr === '?') {
        value = params[paramIndex++];
      } else if (valStr.toLowerCase() === 'null') {
        value = null;
      } else {
        value = valStr.replace(/['"]/g, '');
      }

      if (col === 'machine_id') log.machine_id = value;
      else if (col === 'status') log.status = value;
      else if (col === 'start_time') log.start_time = value ? new Date(value) : new Date();
      else if (col === 'end_time') log.end_time = value ? new Date(value) : null;
      else if (col === 'operator_id') log.operator_id = value;
      else if (col === 'part_name') log.part_name = value;
      else if (col === 'downtime_reason') log.downtime_reason = value;
    });

    const machine = mockDb.machines.find(m => m.id === log.machine_id);
    if (machine) {
      if (!log.part_name) log.part_name = machine.active_part_name;
      if (!log.operator_id) log.operator_id = machine.assigned_operator;
      machine.status = log.status;
    }

    mockDb.status_logs.push(log);
    return [{ insertId: log.id, affectedRows: 1 }, []];
  }

  // 7. UPDATE machines
  if (sqlLower.startsWith('update machines')) {
    let affectedRows = 0;
    if (sqlLower.includes('set name')) {
      const [name, department, target, idealCycleTime, iotEnabled, machineId] = params;
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.name = name;
        machine.department = department;
        machine.target = parseInt(target);
        machine.ideal_cycle_time = parseInt(idealCycleTime);
        machine.iot_enabled = Boolean(iotEnabled);
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set target') && sqlLower.includes('and active_schedule_id')) {
      // partSchedules.js PUT route pushing an edited target/cycle onto the currently-active
      // machine - WHERE id = ? AND active_schedule_id = ? (no active_part_name/operator here,
      // those columns aren't touched by this specific query).
      const [target, ideal, machineId, scheduleId] = params;
      const machine = mockDb.machines.find(m => m.id === machineId && m.active_schedule_id === scheduleId);
      if (machine) {
        machine.target = parseInt(target);
        machine.ideal_cycle_time = parseInt(ideal);
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set target') && sqlLower.includes('active_schedule_id')) {
      const [target, ideal, part, operator, scheduleId, machineId] = params;
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.target = parseInt(target);
        machine.ideal_cycle_time = parseInt(ideal);
        machine.active_part_name = part;
        machine.assigned_operator = operator;
        machine.active_schedule_id = scheduleId;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set target')) {
      const target = params[0];
      const ideal = params[1];
      const part = params[2];
      const operator = params[3];
      const machineId = params[4];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.target = parseInt(target);
        machine.ideal_cycle_time = parseInt(ideal);
        machine.active_part_name = part;
        machine.assigned_operator = operator;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('active_part_name = null')) {
      // Blocking a machine with no active schedule - clears part/operator/active_schedule_id
      // together, regardless of which order they appear in the SQL text.
      const machineId = params[0];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.active_schedule_id = null;
        machine.active_part_name = null;
        machine.assigned_operator = null;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set assigned_operator = ?')) {
      // assign-operator pushing the operator live onto the machine's currently-active entry.
      const [operator, machineId] = params;
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.assigned_operator = operator;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set active_schedule_id = null')) {
      const machineId = params[0];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.active_schedule_id = null;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set last_manual_reset_at = now()')) {
      const machineId = params[0];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.last_manual_reset_at = new Date();
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set last_manual_reset_at = ?')) {
      const [resetAt, machineId] = params;
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.last_manual_reset_at = resetAt;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set last_cycle_reset_at = ?')) {
      const [resetAt, machineId] = params;
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.last_cycle_reset_at = resetAt;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set last_heartbeat = ?')) {
      const [heartbeatAt, machineId] = params;
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.last_heartbeat = heartbeatAt;
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set production_count = 0')) {
      const machineId = params[0];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.production_count = 0;
        machine.good_count = 0;
        machine.scrap_count = 0;
        machine.segment_start = new Date();
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set segment_start = now()')) {
      const machineId = params[0];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.segment_start = new Date();
        affectedRows = 1;
      }
    } else if (sqlLower.includes('set status = ?')) {
      const status = params[0];
      const machineId = params[1];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.status = status;
        affectedRows = 1;
      }
    } else if (sqlLower.includes("set status = 'running'")) {
      const machineId = params[0];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.status = 'Running';
        affectedRows = 1;
      }
    } else if (sqlLower.includes('production_count = production_count + 1')) {
      const timestamp = params[0];
      const machineId = params[1];
      const machine = mockDb.machines.find(m => m.id === machineId);
      if (machine) {
        machine.production_count += 1;
        machine.last_pulse = timestamp;
        // Only mirror the real SQL's status clause - do not force Running unconditionally.
        // handlePulseMessage() intentionally omits "status = 'Running'" from the query when
        // the machine is deliberately Stopped, and the mock DB must respect that or it will
        // silently un-stop a machine on every trailing pulse (a real bug this once was).
        if (sqlLower.includes("status = 'running'")) {
          machine.status = 'Running';
        }

        if (sqlLower.includes('good_count = good_count + 1') || sqlLower.includes('good_count=good_count+1')) {
          machine.good_count += 1;
        } else if (sqlLower.includes('scrap_count = scrap_count + 1') || sqlLower.includes('scrap_count=scrap_count+1')) {
          machine.scrap_count += 1;
        }
        affectedRows = 1;
      }
    }
    return [{ affectedRows }, []];
  }

  // 8. SELECT FROM users
  if (normalizedSql.includes('from users')) {
    let filtered = [...mockDb.users];
    if (normalizedSql.includes('where loginid = ?')) {
      const uId = params[0];
      filtered = filtered.filter(u => u.loginId === uId);
    } else if (normalizedSql.includes('where role = ?')) {
      const role = params[0];
      filtered = filtered.filter(u => u.role === role);
    }
    return [JSON.parse(JSON.stringify(filtered)), []];
  }

  // 9. INSERT INTO users
  if (sqlLower.startsWith('insert into users')) {
    const user = {
      loginId: params[0],
      role: params[1],
      displayName: params[2],
      terminalId: params[3],
      password_hash: params[4] || DEFAULT_SEED_PASSWORD_HASH
    };
    mockDb.users = mockDb.users.filter(u => u.loginId !== user.loginId);
    mockDb.users.push(user);
    return [{ affectedRows: 1 }, []];
  }

  // 10. UPDATE users (password change vs profile update)
  if (sqlLower.startsWith('update users')) {
    if (sqlLower.includes('set password_hash')) {
      const passwordHash = params[0];
      const loginId = params[1];
      mockDb.users.forEach(u => {
        if (u.loginId === loginId) {
          u.password_hash = passwordHash;
        }
      });
    } else {
      const role = params[0];
      const displayName = params[1];
      const terminalId = params[2];
      const loginId = params[3];
      mockDb.users.forEach(u => {
        if (u.loginId === loginId) {
          u.role = role;
          u.displayName = displayName;
          u.terminalId = terminalId;
        }
      });
    }
    return [{ affectedRows: 1 }, []];
  }

  // 11. DELETE FROM users
  if (sqlLower.startsWith('delete from users')) {
    const loginId = params[0];
    mockDb.users = mockDb.users.filter(u => u.loginId !== loginId);
    return [{ affectedRows: 1 }, []];
  }

  // 12. SELECT FROM audit_log
  if (normalizedSql.includes('from audit_log')) {
    const sorted = [...mockDb.audit_log].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return [JSON.parse(JSON.stringify(sorted.slice(0, 200))), []];
  }

  // 13. INSERT INTO audit_log
  if (sqlLower.startsWith('insert into audit_log')) {
    mockDb.audit_log.push({
      id: mockAuditId++,
      timestamp: new Date(),
      actor_login_id: params[0],
      action: params[1],
      target: params[2] || null,
      details: params[3] || null
    });
    return [{ affectedRows: 1 }, []];
  }

  // 14. INSERT INTO machines
  if (sqlLower.startsWith('insert into machines')) {
    const machine = {
      id: params[0],
      name: params[1],
      department: params[2],
      status: 'Not Connected',
      target: parseInt(params[3]) || 0,
      production_count: 0,
      good_count: 0,
      scrap_count: 0,
      ideal_cycle_time: parseInt(params[4]) || 15,
      last_pulse: null,
      active_part_name: params[5] || 'Unassigned',
      assigned_operator: params[6] || 'Unassigned',
      iot_enabled: Boolean(params[7]),
      heartbeat_timeout_seconds: 120
    };
    mockDb.machines = mockDb.machines.filter(m => m.id !== machine.id);
    mockDb.machines.push(machine);
    return [{ affectedRows: 1 }, []];
  }

  // 15. DELETE FROM machines
  if (sqlLower.startsWith('delete from machines')) {
    const machineId = params[0];
    mockDb.machines = mockDb.machines.filter(m => m.id !== machineId);
    mockDb.pulses = mockDb.pulses.filter(p => p.machine_id !== machineId);
    mockDb.status_logs = mockDb.status_logs.filter(l => l.machine_id !== machineId);
    return [{ affectedRows: 1 }, []];
  }

  // 16. SELECT FROM shift_plans
  if (normalizedSql.includes('from shift_plans')) {
    let filtered = [...mockDb.shift_plans];
    if (normalizedSql.includes('machine_id = ?') && normalizedSql.includes('shift = ?')) {
      const [mId, planDate, shift] = params;
      filtered = filtered.filter(p => p.machine_id === mId && p.plan_date === planDate && p.shift === shift);
    } else if (normalizedSql.includes('where id = ?')) {
      const id = params[0];
      filtered = filtered.filter(p => p.id === id);
    } else if (normalizedSql.includes('plan_date = ?')) {
      const planDate = params[0];
      filtered = filtered.filter(p => p.plan_date === planDate);
    }
    return [JSON.parse(JSON.stringify(filtered)), []];
  }

  // 17. INSERT INTO shift_plans
  if (sqlLower.startsWith('insert into shift_plans')) {
    const [machineId, planDate, shift, target, idealCycleTime, partName, operator, createdBy, updatedBy] = params;
    const now = new Date();
    const plan = {
      id: mockShiftPlanId++,
      machine_id: machineId,
      plan_date: planDate,
      shift,
      target: parseInt(target),
      ideal_cycle_time: parseInt(idealCycleTime),
      part_name: partName || null,
      operator: operator || null,
      created_by: createdBy || null,
      updated_by: updatedBy || createdBy || null,
      created_at: now,
      updated_at: now
    };
    mockDb.shift_plans.push(plan);
    return [{ insertId: plan.id, affectedRows: 1 }, []];
  }

  // 18. UPDATE shift_plans
  if (sqlLower.startsWith('update shift_plans')) {
    const [target, idealCycleTime, partName, operator, updatedBy, id] = params;
    const plan = mockDb.shift_plans.find(p => p.id === id);
    if (plan) {
      plan.target = parseInt(target);
      plan.ideal_cycle_time = parseInt(idealCycleTime);
      plan.part_name = partName || null;
      plan.operator = operator || null;
      plan.updated_by = updatedBy || null;
      plan.updated_at = new Date();
    }
    return [{ affectedRows: plan ? 1 : 0 }, []];
  }

  // 19. SELECT FROM production_records
  if (normalizedSql.includes('from production_records')) {
    let filtered = [...mockDb.production_records];
    if (normalizedSql.includes('where machine_id = ?')) {
      const mId = params[0];
      filtered = filtered.filter(r => r.machine_id === mId);
    }
    filtered.sort((a, b) => new Date(b.end_time) - new Date(a.end_time));
    return [JSON.parse(JSON.stringify(filtered.slice(0, 100))), []];
  }

  // 20. INSERT INTO production_records
  if (sqlLower.startsWith('insert into production_records')) {
    const [
      machineId, partName, operator, shift, target, productionCount, goodCount, scrapCount, resetReason, resetBy, startTime,
      scheduleId, previousPartName, nextPartName, changedBy, changeTrigger, changeReason
    ] = params;
    const record = {
      id: mockProductionRecordId++,
      machine_id: machineId,
      part_name: partName,
      operator,
      shift,
      target: parseInt(target) || 0,
      production_count: parseInt(productionCount) || 0,
      good_count: parseInt(goodCount) || 0,
      scrap_count: parseInt(scrapCount) || 0,
      reset_reason: resetReason,
      reset_by: resetBy,
      start_time: startTime,
      end_time: new Date(),
      schedule_id: scheduleId ?? null,
      previous_part_name: previousPartName ?? null,
      next_part_name: nextPartName ?? null,
      changed_by: changedBy ?? null,
      change_trigger: changeTrigger ?? null,
      change_reason: changeReason ?? null
    };
    mockDb.production_records.push(record);
    return [{ insertId: record.id, affectedRows: 1 }, []];
  }

  // 21a. SELECT COALESCE(MAX(sequence), 0) FROM part_schedules (aggregate, next-sequence lookup)
  if (normalizedSql.includes('max(sequence)') && normalizedSql.includes('from part_schedules')) {
    const [mId, planDate, shift] = params;
    const filtered = mockDb.part_schedules.filter(p => p.machine_id === mId && p.plan_date === planDate && p.shift === shift);
    const maxSeq = filtered.length > 0 ? Math.max(...filtered.map(p => p.sequence)) : 0;
    return [[{ maxSeq }], []];
  }

  // 21. SELECT FROM part_schedules
  if (normalizedSql.includes('from part_schedules')) {
    let filtered = [...mockDb.part_schedules];
    if (normalizedSql.includes('where id = ?')) {
      const id = params[0];
      filtered = filtered.filter(p => p.id === id);
    } else if (normalizedSql.includes('plan_date = ?') && normalizedSql.includes('shift = ?') && normalizedSql.includes('operator = ?') && normalizedSql.includes('machine_id !=')) {
      // assign-operator's double-booking check: WHERE plan_date = ? AND shift = ? AND
      // operator = ? AND machine_id != ? - is this operator already on a DIFFERENT machine?
      const [planDate, shift, operatorId, excludeMachineId] = params;
      filtered = filtered.filter(p => p.plan_date === planDate && p.shift === shift && p.operator === operatorId && p.machine_id !== excludeMachineId);
    } else if (normalizedSql.includes('plan_date = ?') && normalizedSql.includes('shift = ?') && !normalizedSql.includes('machine_id = ?')) {
      // operator-availability's cross-machine lookup: WHERE plan_date = ? AND shift = ? [AND
      // operator IS NOT NULL] - no machine_id filter, since this scans every machine at once.
      const [planDate, shift] = params;
      filtered = filtered.filter(p => p.plan_date === planDate && p.shift === shift);
      if (normalizedSql.includes('operator is not null')) {
        filtered = filtered.filter(p => p.operator !== null && p.operator !== undefined);
      }
    } else if (normalizedSql.includes('machine_id = ?') && normalizedSql.includes('shift = ?') && normalizedSql.includes('sequence > ?')) {
      const [mId, planDate, shift, seq] = params;
      filtered = filtered.filter(p => p.machine_id === mId && p.plan_date === planDate && p.shift === shift && p.sequence > seq);
    } else if (normalizedSql.includes('machine_id = ?') && normalizedSql.includes('shift = ?') && normalizedSql.includes('sequence = ?')) {
      const [mId, planDate, shift, seq] = params;
      filtered = filtered.filter(p => p.machine_id === mId && p.plan_date === planDate && p.shift === shift && p.sequence === seq);
    } else if (normalizedSql.includes('machine_id = ?') && normalizedSql.includes('shift = ?')) {
      const [mId, planDate, shift] = params;
      filtered = filtered.filter(p => p.machine_id === mId && p.plan_date === planDate && p.shift === shift);
    } else if (normalizedSql.includes('machine_id = ?') && normalizedSql.includes('plan_date = ?')) {
      const [mId, planDate] = params;
      filtered = filtered.filter(p => p.machine_id === mId && p.plan_date === planDate);
    } else if (normalizedSql.includes('plan_date = ?')) {
      const planDate = params[0];
      filtered = filtered.filter(p => p.plan_date === planDate);
    }
    filtered.sort((a, b) => a.sequence - b.sequence);
    return [JSON.parse(JSON.stringify(filtered)), []];
  }

  // 22. INSERT INTO part_schedules
  if (sqlLower.startsWith('insert into part_schedules')) {
    const colMatch = sql.match(/\(([^)]+)\)/);
    const columns = colMatch ? colMatch[1].split(',').map(c => c.trim().toLowerCase()) : [];
    const valMatch = sql.match(/values\s*\(([^)]+)\)/i);
    const valStrings = valMatch ? valMatch[1].split(',').map(v => v.trim()) : [];

    const entry = {
      id: mockPartScheduleId++,
      machine_id: null, plan_date: null, shift: null, sequence: 1, part_name: null,
      target: 0, ideal_cycle_time: 15, operator: null, planned_start: '00:00:00', planned_end: '00:00:00',
      status: 'Pending', activated_at: null, completed_at: null, created_by: null, updated_by: null,
      created_at: new Date(), updated_at: new Date(),
      part_number: null, part_operation: null, load_unload_allowance_seconds: null
    };

    // Columns can mix '?' placeholders with SQL literals (e.g. the fixed 'Pending' status in
    // the real INSERT) - only advance the params index for actual placeholders, matching the
    // parsing pattern already used for INSERT INTO status_logs above.
    let paramIndex = 0;
    columns.forEach((col, idx) => {
      const valStr = valStrings[idx];
      let value;
      if (valStr === '?') {
        value = params[paramIndex++];
      } else if (valStr === undefined || valStr.toLowerCase() === 'null') {
        value = null;
      } else {
        value = valStr.replace(/['"]/g, '');
      }
      if (col in entry) entry[col] = value;
    });

    entry.target = parseInt(entry.target) || 0;
    entry.ideal_cycle_time = parseInt(entry.ideal_cycle_time) || 15;
    entry.sequence = parseInt(entry.sequence) || 1;
    mockDb.part_schedules.push(entry);
    return [{ insertId: entry.id, affectedRows: 1 }, []];
  }

  // 23. UPDATE part_schedules
  if (sqlLower.startsWith('update part_schedules')) {
    // assign-operator's bulk write: SET operator = ?, updated_by = ? WHERE machine_id = ? AND
    // plan_date = ? AND shift = ? - every entry for that shift gets the same operator at once.
    if (sqlLower.includes('set operator = ?') && sqlLower.includes('machine_id = ?')) {
      const [operator, updatedBy, machineId, planDate, shift] = params;
      let affectedRows = 0;
      mockDb.part_schedules.forEach((entry) => {
        if (entry.machine_id === machineId && entry.plan_date === planDate && entry.shift === shift) {
          entry.operator = operator;
          entry.updated_by = updatedBy || null;
          entry.updated_at = new Date();
          affectedRows++;
        }
      });
      return [{ affectedRows }, []];
    }
    // Bulk sequence renumber: UPDATE part_schedules SET sequence = ? WHERE id = ?
    if (sqlLower.includes('set sequence = ?') && !sqlLower.includes('status')) {
      const [sequence, id] = params;
      const entry = mockDb.part_schedules.find(p => p.id === id);
      if (entry) {
        entry.sequence = parseInt(sequence);
        entry.updated_at = new Date();
      }
      return [{ affectedRows: entry ? 1 : 0 }, []];
    }
    // Activation transition: SET status = 'Running', activated_at = NOW() WHERE id = ?
    // (status is a literal in the real SQL, not a placeholder - only `id` is passed as a param)
    if (sqlLower.includes('activated_at')) {
      const id = params[0];
      const entry = mockDb.part_schedules.find(p => p.id === id);
      if (entry) {
        entry.status = 'Running';
        entry.activated_at = new Date();
      }
      return [{ affectedRows: entry ? 1 : 0 }, []];
    }
    // Completion transition: SET status = 'Completed', completed_at = NOW() WHERE id = ?
    if (sqlLower.includes('completed_at')) {
      const id = params[0];
      const entry = mockDb.part_schedules.find(p => p.id === id);
      if (entry) {
        entry.status = 'Completed';
        entry.completed_at = new Date();
      }
      return [{ affectedRows: entry ? 1 : 0 }, []];
    }
    // Manual-entry field edit: SET target=?, ideal_cycle_time=?, part_number=?, part_name=?,
    // part_operation=?, load_unload_allowance_seconds=?, planned_start=?, planned_end=?,
    // updated_by=? WHERE id=?
    if (sqlLower.includes('load_unload_allowance_seconds')) {
      const [target, idealCycleTime, partNumber, partName, partOperation, allowance, plannedStart, plannedEnd, updatedBy, id] = params;
      const entry = mockDb.part_schedules.find(p => p.id === id);
      if (entry) {
        entry.target = parseInt(target);
        entry.ideal_cycle_time = parseInt(idealCycleTime);
        entry.part_number = partNumber;
        entry.part_name = partName;
        entry.part_operation = partOperation || null;
        entry.load_unload_allowance_seconds = parseInt(allowance);
        entry.planned_start = plannedStart;
        entry.planned_end = plannedEnd;
        entry.updated_by = updatedBy || null;
        entry.updated_at = new Date();
      }
      return [{ affectedRows: entry ? 1 : 0 }, []];
    }
    // Legacy generic field edit (pre-manual-entry rows): SET target=?, ideal_cycle_time=?, operator=?, planned_start=?, planned_end=?, updated_by=? WHERE id=?
    const [target, idealCycleTime, operator, plannedStart, plannedEnd, updatedBy, id] = params;
    const entry = mockDb.part_schedules.find(p => p.id === id);
    if (entry) {
      entry.target = parseInt(target);
      entry.ideal_cycle_time = parseInt(idealCycleTime);
      entry.operator = operator || null;
      entry.planned_start = plannedStart;
      entry.planned_end = plannedEnd;
      entry.updated_by = updatedBy || null;
      entry.updated_at = new Date();
    }
    return [{ affectedRows: entry ? 1 : 0 }, []];
  }

  // 24. DELETE FROM part_schedules
  if (sqlLower.startsWith('delete from part_schedules')) {
    const id = params[0];
    const before = mockDb.part_schedules.length;
    mockDb.part_schedules = mockDb.part_schedules.filter(p => p.id !== id);
    return [{ affectedRows: before - mockDb.part_schedules.length }, []];
  }

  return [{ affectedRows: 0 }, []];
}

const db = {
  // A getter, not a captured value: `isMock` can now flip back to false after a successful
  // background reconnect (see attemptReconnect() above), and every caller of `db.isMock`
  // (server.js's /api/health, oeeCalculator.js, reportingService.js) must see that live state
  // rather than whatever it was the instant this object was constructed at module load.
  get isMock() {
    return isMock;
  },
  query: async (sql, params) => {
    if (isMock) {
      return mockQuery(sql, params);
    }
    return pool.query(sql, params);
  },
  execute: async (sql, params) => {
    if (isMock) {
      return mockQuery(sql, params);
    }
    return pool.execute(sql, params);
  },
  getConnection: async () => {
    if (isMock) {
      return {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        query: async (sql, params) => mockQuery(sql, params),
        release: () => {}
      };
    }
    return pool.getConnection();
  },
  getPool: () => pool
};

export default db;
