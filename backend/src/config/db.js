import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

let pool = null;
let isMock = false;

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
  users: []
};

let mockPulseId = 1;
let mockLogId = 1;

// Seed rich mock data
function seedMockData() {
  const now = new Date();
  
  // 1. Initialize users
  mockDb.users = [
    { loginId: 'SUP-201', role: 'Supervisor', displayName: 'Supervisor User', terminalId: 'DASHBOARD' },
    { loginId: 'PPC-301', role: 'PPC Engineer', displayName: 'PPC Engineer', terminalId: 'PLANNING-BOARD' },
    { loginId: 'ADMIN', role: 'Admin', displayName: 'Admin User', terminalId: 'CONTROL-ROOM' }
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
    'Preventive Maintenance'
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

try {
  const connectionConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'cnc_dashboard',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };

  if (process.env.DB_PASSWORD === 'your_mysql_password' || !process.env.DB_PASSWORD) {
    console.warn('⚠️  Database password is unset or placeholder. Falling back to IN-MEMORY MOCK database mode.');
    isMock = true;
    seedMockData();
  } else {
    pool = mysql.createPool(connectionConfig);
    const conn = await pool.getConnection();
    console.log('✅ Connected to MySQL successfully.');
    conn.release();
    
    // Create users table and seed initial users in MySQL if empty
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        loginId VARCHAR(50) PRIMARY KEY,
        role VARCHAR(50) NOT NULL,
        displayName VARCHAR(100) NOT NULL,
        terminalId VARCHAR(50) NOT NULL
      )
    `);
    
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM users');
    if (rows[0].count === 0) {
      await pool.query(`
        INSERT INTO users (loginId, role, displayName, terminalId) VALUES
        ('SUP-201', 'Supervisor', 'Supervisor User', 'DASHBOARD'),
        ('PPC-301', 'PPC Engineer', 'PPC Engineer', 'PLANNING-BOARD'),
        ('ADMIN', 'Admin', 'Admin User', 'CONTROL-ROOM')
      `);
      console.log('✅ Seeded users table in MySQL.');
    }
  }
} catch (error) {
  console.warn('⚠️  Could not connect to MySQL database. Details:', error.message);
  isMock = true;
  pool = null;
  seedMockData();
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
    return [JSON.parse(JSON.stringify(filtered)), []];
  }

  // 2. SELECT FROM pulses
  if (normalizedSql.includes('from pulses')) {
    let filtered = [...mockDb.pulses];
    if (normalizedSql.includes('where machine_id = ?')) {
      const mId = params[0];
      filtered = filtered.filter(p => p.machine_id === mId);
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
    const pulse = {
      id: mockPulseId++,
      machine_id: params[0],
      timestamp: params[1] || new Date(),
      cycle_time: parseFloat(params[2] || 0)
    };
    mockDb.pulses.push(pulse);
    return [{ insertId: pulse.id, affectedRows: 1 }, []];
  }

  // 5. UPDATE status_logs
  if (sqlLower.startsWith('update status_logs')) {
    let affectedRows = 0;
    if (sqlLower.includes('downtime_reason = ?') || sqlLower.includes('downtime_reason=?')) {
      const endTime = params[0];
      const reason = params[1];
      const logId = params[2];
      mockDb.status_logs.forEach(log => {
        if (log.id === logId) {
          log.end_time = endTime;
          log.downtime_reason = reason;
          affectedRows++;
        }
      });
    } else {
      const endTime = params[0];
      const logId = params[1];
      mockDb.status_logs.forEach(log => {
        if (log.id === logId) {
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
    if (sqlLower.includes('set target')) {
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
        machine.status = 'Running';
        
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
    }
    return [JSON.parse(JSON.stringify(filtered)), []];
  }

  // 9. INSERT INTO users
  if (sqlLower.startsWith('insert into users')) {
    const user = {
      loginId: params[0],
      role: params[1],
      displayName: params[2],
      terminalId: params[3]
    };
    mockDb.users = mockDb.users.filter(u => u.loginId !== user.loginId);
    mockDb.users.push(user);
    return [{ affectedRows: 1 }, []];
  }

  // 10. UPDATE users
  if (sqlLower.startsWith('update users')) {
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
    return [{ affectedRows: 1 }, []];
  }

  // 11. DELETE FROM users
  if (sqlLower.startsWith('delete from users')) {
    const loginId = params[0];
    mockDb.users = mockDb.users.filter(u => u.loginId !== loginId);
    return [{ affectedRows: 1 }, []];
  }

  return [{ affectedRows: 0 }, []];
}

const db = {
  isMock,
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
  getPool: () => pool
};

export default db;
