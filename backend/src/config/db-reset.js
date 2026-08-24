import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

async function reset() {
  const connectionConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD === 'your_mysql_password' ? '' : process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'cnc_dashboard'
  };
  // Same optional TLS support as db.js/db-setup.js - required for a managed host like Aiven.
  if (process.env.DB_SSL === 'true') {
    connectionConfig.ssl = process.env.DB_SSL_CA_PATH
      ? { ca: fs.readFileSync(process.env.DB_SSL_CA_PATH), rejectUnauthorized: true }
      : { rejectUnauthorized: true };
  }

  console.log(`🧹 Attempting to reset database at ${connectionConfig.host}:${connectionConfig.port}...`);
  let connection;

  try {
    connection = await mysql.createConnection(connectionConfig);
    
    // Clear old test data
    console.log('   - Clearing old pulses...');
    await connection.query('DELETE FROM pulses');
    
    console.log('   - Clearing old status logs...');
    await connection.query('DELETE FROM status_logs');
    
    // Reset machine telemetry statistics
    console.log('   - Resetting CNC machine telemetry counters...');
    await connection.query(`
      UPDATE machines SET 
        production_count = 0, 
        good_count = 0, 
        scrap_count = 0, 
        status = 'Stopped',
        last_pulse = NULL
    `);
    
    console.log('🎉 Database reset completed successfully! All old test data has been cleared.');
  } catch (error) {
    console.error('❌ Failed to reset database:', error.message);
  } finally {
    if (connection) await connection.end();
  }
}

reset();
