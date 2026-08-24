import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import fs from 'fs';

dotenv.config();

const DEFAULT_SEED_PASSWORD_HASH = bcrypt.hashSync('1234', 10);

async function setup() {
  const connectionConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD === 'your_mysql_password' ? '' : process.env.DB_PASSWORD
  };
  // Same optional TLS support as db.js - required for a managed host like Aiven that
  // enforces TLS. No-op for a local/on-prem MySQL that doesn't set DB_SSL.
  if (process.env.DB_SSL === 'true') {
    connectionConfig.ssl = process.env.DB_SSL_CA_PATH
      ? { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true }
      : { rejectUnauthorized: true };
  }

  console.log(`🔌 Attempting to connect to MySQL server at ${connectionConfig.host}:${connectionConfig.port}...`);
  let connection;

  try {
    connection = await mysql.createConnection(connectionConfig);
    console.log('✅ Connected to MySQL server.');
  } catch (error) {
    console.error('❌ Failed to connect to MySQL server.');
    console.error('Error Details:', error.message);
    process.exit(1);
  }

  try {
    const dbName = process.env.DB_NAME || 'cnc_dashboard';
    
    // Create database
    console.log(`📦 Creating database "${dbName}" if it does not exist...`);
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.query(`USE \`${dbName}\``);
    console.log(`✅ Selected database "${dbName}".`);

    // Create machines table
    console.log('🛠️  Creating "machines" table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS machines (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        department VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Not Connected',
        target INT NOT NULL DEFAULT 500,
        production_count INT NOT NULL DEFAULT 0,
        good_count INT NOT NULL DEFAULT 0,
        scrap_count INT NOT NULL DEFAULT 0,
        ideal_cycle_time INT NOT NULL DEFAULT 15,
        last_pulse TIMESTAMP NULL,
        active_part_name VARCHAR(100) NULL DEFAULT 'Unassigned',
        assigned_operator VARCHAR(100) NULL DEFAULT 'Unassigned',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create pulses table
    console.log('🛠️  Creating "pulses" table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS pulses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        machine_id VARCHAR(50) NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        cycle_time DECIMAL(8,2) NOT NULL,
        is_good BOOLEAN NOT NULL DEFAULT TRUE,
        synced BOOLEAN NOT NULL DEFAULT FALSE,
        FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
      )
    `);
    try {
      await connection.query('ALTER TABLE pulses ADD COLUMN synced BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('   + Added "synced" column to pulses table');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await connection.query('ALTER TABLE pulses ADD INDEX idx_pulses_machine_timestamp (machine_id, timestamp)');
      console.log('   + Added index "idx_pulses_machine_timestamp" to pulses table');
    } catch (err) {
      // Ignore if index already exists
    }

    // Create status_logs table
    console.log('🛠️  Creating "status_logs" table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS status_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        machine_id VARCHAR(50) NOT NULL,
        status VARCHAR(50) NOT NULL,
        start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP NULL,
        downtime_reason VARCHAR(255) NULL,
        operator_id VARCHAR(50) NULL,
        part_name VARCHAR(100) NULL,
        synced BOOLEAN NOT NULL DEFAULT FALSE,
        FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
      )
    `);
    try {
      await connection.query('ALTER TABLE status_logs ADD COLUMN synced BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('   + Added "synced" column to status_logs table');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await connection.query('ALTER TABLE status_logs ADD INDEX idx_status_logs_machine_start (machine_id, start_time)');
      console.log('   + Added index "idx_status_logs_machine_start" to status_logs table');
    } catch (err) {
      // Ignore if index already exists
    }
    // PERMANENT FIX for duplicate open status_logs rows - see the matching, more detailed
    // comment in db.js's connectAndSetupRealDatabase(), which is what actually runs this
    // migration against a live server's DB on every boot. Mirrored here so a fresh install
    // (npm run setup) creates the table with the invariant already in place.
    try {
      await connection.query(
        'ALTER TABLE status_logs ADD COLUMN is_open TINYINT GENERATED ALWAYS AS (IF(end_time IS NULL, 1, NULL)) STORED'
      );
      console.log('   + Added "is_open" generated column to status_logs table');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await connection.query(
        'ALTER TABLE status_logs ADD UNIQUE KEY uniq_status_logs_open_machine (machine_id, is_open)'
      );
      console.log('   + Added unique constraint enforcing one open status log per machine');
    } catch (err) {
      // Ignore if constraint already exists
    }

    // Create users table
    console.log('🛠️  Creating "users" table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        loginId VARCHAR(50) PRIMARY KEY,
        role VARCHAR(50) NOT NULL,
        displayName VARCHAR(100) NOT NULL,
        terminalId VARCHAR(50) NOT NULL,
        password_hash VARCHAR(100) NOT NULL DEFAULT ''
      )
    `);

    // Create audit_log table
    console.log('🛠️  Creating "audit_log" table...');
    await connection.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actor_login_id VARCHAR(50) NOT NULL,
        action VARCHAR(100) NOT NULL,
        target VARCHAR(100) NULL,
        details VARCHAR(500) NULL
      )
    `);

    // Create shift_plans table (dated PPC shift scheduling)
    console.log('🛠️  Creating "shift_plans" table...');
    await connection.query(`
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

    // Create production_records table (permanent history of each closed-out part/shift run)
    console.log('🛠️  Creating "production_records" table...');
    await connection.query(`
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
    try {
      await connection.query('ALTER TABLE machines ADD COLUMN segment_start TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP');
      console.log('   + Added "segment_start" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }

    // Create part_schedules table (ordered, unlimited-length list of parts a machine runs
    // sequentially within one shift)
    console.log('🛠️  Creating "part_schedules" table...');
    await connection.query(`
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

    try {
      await connection.query('ALTER TABLE machines ADD COLUMN active_schedule_id INT NULL');
      console.log('   + Added "active_schedule_id" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await connection.query('ALTER TABLE machines ADD COLUMN last_manual_reset_at TIMESTAMP NULL');
      console.log('   + Added "last_manual_reset_at" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await connection.query('ALTER TABLE machines ADD COLUMN last_cycle_reset_at TIMESTAMP NULL');
      console.log('   + Added "last_cycle_reset_at" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }
    // Connectivity: iot_enabled marks a machine as physically wired to an ESP32/Raspberry Pi.
    // A machine with iot_enabled = FALSE never receives real pulses/status - it must always
    // read "Not Connected", never a fabricated Running/Stopped/OEE state. heartbeat_timeout_seconds
    // is the per-machine override for how long a *connected* machine can go without a pulse
    // before the watchdog (see watchdogService.js) also declares it Not Connected.
    try {
      await connection.query('ALTER TABLE machines ADD COLUMN iot_enabled BOOLEAN NOT NULL DEFAULT FALSE');
      console.log('   + Added "iot_enabled" column to machines table');
      // See the matching backfill in db.js - every pre-existing machine was already being
      // treated as physically connected before this column existed.
      await connection.query('UPDATE machines SET iot_enabled = TRUE');
      console.log('   + Backfilled "iot_enabled" = TRUE on all pre-existing machines');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await connection.query('ALTER TABLE machines ADD COLUMN heartbeat_timeout_seconds INT NOT NULL DEFAULT 120');
      console.log('   + Added "heartbeat_timeout_seconds" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }
    // Last time this machine's ESP32 sent a liveness heartbeat - see the matching comment in
    // db.js. Separate from last_pulse (production-only); this is what connectivity is judged on.
    try {
      await connection.query('ALTER TABLE machines ADD COLUMN last_heartbeat TIMESTAMP NULL');
      console.log('   + Added "last_heartbeat" column to machines table');
    } catch (err) {
      // Ignore if column already exists
    }
    try {
      await connection.query('ALTER TABLE pulses ADD COLUMN part_schedule_id INT NULL');
      console.log('   + Added "part_schedule_id" column to pulses table');
    } catch (err) {
      // Ignore if column already exists
    }

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
        await connection.query(`ALTER TABLE production_records ADD COLUMN ${column} ${definition}`);
        console.log(`   + Added "${column}" column to production_records table`);
      } catch (err) {
        // Ignore if column already exists
      }
    }

    // No Part Master catalog and no Admin-configured default allowance - the PPC Engineer types
    // Part Number, Part Name, Part Operation, Ideal Cycle Time, and the Loading/Unloading
    // Allowance directly on every schedule entry. part_id/parts/production_settings (an earlier
    // catalog-based design) are no longer written to by any route; these columns just add the
    // manually-entered fields that replace them.
    const partScheduleManualEntryColumns = [
      ['part_number', 'VARCHAR(50) NULL'],
      ['part_operation', 'VARCHAR(150) NULL'],
      ['load_unload_allowance_seconds', 'INT NULL']
    ];
    for (const [column, definition] of partScheduleManualEntryColumns) {
      try {
        await connection.query(`ALTER TABLE part_schedules ADD COLUMN ${column} ${definition}`);
        console.log(`   + Added "${column}" column to part_schedules table`);
      } catch (err) {
        // Ignore if column already exists
      }
    }

    // Seed default plant accounts (default password: 1234 - change before go-live)
    console.log('🌱 Seeding default user accounts...');
    const seedUsers = [
      ['SUP-201', 'Supervisor', 'Supervisor User', 'DASHBOARD'],
      ['PPC-301', 'PPC Engineer', 'PPC Engineer', 'PLANNING-BOARD'],
      ['ADMIN', 'Admin', 'Admin User', 'CONTROL-ROOM']
    ];
    for (const [loginId, role, displayName, terminalId] of seedUsers) {
      const [existing] = await connection.query('SELECT loginId FROM users WHERE loginId = ?', [loginId]);
      if (existing.length === 0) {
        await connection.query(
          'INSERT INTO users (loginId, role, displayName, terminalId, password_hash) VALUES (?, ?, ?, ?, ?)',
          [loginId, role, displayName, terminalId, DEFAULT_SEED_PASSWORD_HASH]
        );
        console.log(`   + Created user account: ${loginId} (${role})`);
      } else {
        console.log(`   - User ${loginId} already exists, skipping.`);
      }
    }

    // Seed machines (8 CNC stations with planning profiles)
    console.log('🌱 Seeding initial 8 CNC machines data...');
    const seedMachines = [
      ['1302', '1302 DOOSAN CNC LYNX 220', 'Milling', 'Running', 300, 20, 'Pinion Gear', 'OP-101'],
      ['1306', '1306 ACE CNC SUPER JOBBER', 'Milling', 'Running', 150, 45, 'Turbine Blade', 'OP-101'],
      ['1308', '1308 ACE CNC SUPER JOBBER', 'Turning', 'Running', 400, 15, 'Collar Bushing', 'OP-102'],
      ['1309', '1309 ACE CNC SUPER JOBBER', 'Turning', 'Running', 500, 12, 'Drive Shaft', 'OP-102'],
      ['1310', '1310 ACE CNC SUPER JOBBER', 'Laser', 'Running', 800, 8, 'Mounting Plate', 'OP-103'],
      ['1311', '1311 VERTICAL TRIMMING MACHINE', 'Laser', 'Running', 600, 10, 'Enclosure Panel', 'OP-103'],
      ['1312', '1312 ACE CNC SUPER JOBBER', 'Grinding', 'Stopped', 250, 25, 'Crankshaft Pin', 'OP-101'],
      ['1313', '1313 ACE CNC SUPER JOBBER', 'Drilling', 'Running', 500, 12, 'Flange Hanger', 'OP-104']
    ];

    for (const [id, name, department, status, target, ideal_cycle_time, part_name, operator] of seedMachines) {
      // Check if machine already exists
      const [existing] = await connection.query('SELECT id FROM machines WHERE id = ?', [id]);
      if (existing.length === 0) {
        await connection.query(
          'INSERT INTO machines (id, name, department, status, target, ideal_cycle_time, active_part_name, assigned_operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, name, department, status, target, ideal_cycle_time, part_name, operator]
        );
        console.log(`   + Created machine: ${id} (${department}) - Part: ${part_name}`);
      } else {
        console.log(`   - Machine ${id} already exists, skipping.`);
      }
    }

    // Seed initial status log starting at midnight for calculations
    console.log('🌱 Seeding initial status logs starting at midnight today...');
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    for (const [id, name, department, status, target, ideal_cycle_time, part_name, operator] of seedMachines) {
      const [activeLogs] = await connection.query(
        'SELECT id FROM status_logs WHERE machine_id = ? AND end_time IS NULL',
        [id]
      );
      if (activeLogs.length === 0) {
        await connection.query(
          'INSERT INTO status_logs (machine_id, status, start_time, operator_id, part_name) VALUES (?, ?, ?, ?, ?)',
          [id, status, midnight, operator, part_name]
        );
        console.log(`   + Created initial status log (${status}) for machine: ${id}`);
      }
    }

    console.log('🎉 MySQL Database Setup completed successfully!');
  } catch (error) {
    console.error('❌ Error during setup:', error.message);
  } finally {
    if (connection) await connection.end();
  }
}

setup();
