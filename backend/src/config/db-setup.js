import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

async function setup() {
  const connectionConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD === 'your_mysql_password' ? '' : process.env.DB_PASSWORD
  };

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
        status VARCHAR(50) NOT NULL DEFAULT 'No Signal',
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
