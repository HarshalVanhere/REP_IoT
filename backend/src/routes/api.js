import express from 'express';
import db from '../config/db.js';
import { calculateOEE } from '../services/oeeCalculator.js';
import { handleStatusMessage, handleResumeMessage, publishMQTT } from '../services/mqttService.js';

const router = express.Router();

/**
 * Fetch all machines with real-time OEE metrics
 */
router.get('/machines', async (req, res) => {
  try {
    const [machines] = await db.query('SELECT * FROM machines');
    
    const enrichedMachines = await Promise.all(
      machines.map(async (machine) => {
        const metrics = await calculateOEE(machine.id);
        return {
          ...machine,
          metrics
        };
      })
    );
    
    res.json(enrichedMachines);
  } catch (err) {
    console.error('API Error: GET /machines:', err.message);
    res.status(500).json({ error: 'Failed to retrieve machines list' });
  }
});

/**
 * Fetch pulse history for a specific machine (last 30 pulses)
 */
router.get('/machines/:id/history', async (req, res) => {
  const machineId = req.params.id;
  try {
    const [pulses] = await db.query(
      'SELECT id, timestamp, cycle_time, is_good FROM pulses WHERE machine_id = ? ORDER BY timestamp DESC LIMIT 30',
      [machineId]
    );
    // Return chronologically (oldest to newest)
    res.json(pulses.reverse());
  } catch (err) {
    console.error(`API Error: GET /machines/${machineId}/history:`, err.message);
    res.status(500).json({ error: 'Failed to retrieve pulse history' });
  }
});

/**
 * Simulated sensor cycle pulse (Operator Touchscreen demo simulator action)
 */
router.post('/simulator/force-pulse', async (req, res) => {
  const { machineId } = req.body;
  if (!machineId) {
    return res.status(400).json({ error: 'machineId is required' });
  }
  try {
    const [machines] = await db.query('SELECT ideal_cycle_time FROM machines WHERE id = ?', [machineId]);
    const ideal = machines.length > 0 ? machines[0].ideal_cycle_time : 15;
    
    const cycleTime = parseFloat((ideal + (Math.random() * 4 - 2)).toFixed(2));
    const isGood = Math.random() > 0.02; // 98% quality rate
    
    publishMQTT(`cnc/${machineId}/pulse`, { cycleTime, isGood });
    res.json({ success: true, message: `Pulse triggered for ${machineId}` });
  } catch (err) {
    console.error(`Pulse Simulation Error for ${machineId}:`, err.message);
    res.status(500).json({ error: 'Failed to simulate machine pulse' });
  }
});

/**
 * Stop machine (Operator touchscreen interface action)
 */
router.post('/machines/:id/stop', async (req, res) => {
  const machineId = req.params.id;
  try {
    await handleStatusMessage(machineId, 'Stopped');
    res.json({ success: true, message: `CNC Machine ${machineId} status set to Stopped` });
  } catch (err) {
    console.error(`API Error: POST /machines/${machineId}/stop:`, err.message);
    res.status(500).json({ error: 'Failed to stop CNC machine' });
  }
});

/**
 * Resume machine with downtime reason (Operator touchscreen interface action)
 */
router.post('/machines/:id/resume', async (req, res) => {
  const machineId = req.params.id;
  const { reason, operatorId } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'Downtime reason is required to resume production' });
  }

  try {
    await handleResumeMessage(machineId, reason, operatorId);
    res.json({ success: true, message: `CNC Machine ${machineId} resumed in Running state` });
  } catch (err) {
    console.error(`API Error: POST /machines/${machineId}/resume:`, err.message);
    res.status(500).json({ error: 'Failed to resume CNC machine' });
  }
});

/**
 * Fetch logs history for plant management reports
 */
router.get('/reports', async (req, res) => {
  try {
    const [reports] = await db.query(`
      SELECT sl.id, sl.machine_id, m.name as machine_name, m.department as machine_section, sl.status, sl.start_time, sl.end_time, sl.downtime_reason, sl.operator_id, sl.part_name 
      FROM status_logs sl 
      JOIN machines m ON sl.machine_id = m.id 
      ORDER BY sl.start_time DESC 
      LIMIT 100
    `);
    res.json(reports);
  } catch (err) {
    console.error('API/Reports Error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve reports log' });
  }
});

/**
 * PPC Production Planning update (set Target, Ideal Cycle Time, Part Name, and Operator)
 */
router.post('/machines/:id/planning', async (req, res) => {
  const machineId = req.params.id;
  const { target, ideal_cycle_time, active_part_name, assigned_operator } = req.body;

  if (target === undefined || ideal_cycle_time === undefined) {
    return res.status(400).json({ error: 'target and ideal_cycle_time are required' });
  }

  const numTarget = parseInt(target);
  const numCycleTime = parseInt(ideal_cycle_time);

  if (isNaN(numTarget) || isNaN(numCycleTime)) {
    return res.status(400).json({ error: 'Target and ideal cycle time must be valid numbers' });
  }

  const partName = active_part_name || 'Unassigned';
  const operator = assigned_operator || 'Unassigned';

  try {
    // 1. Update target, ideal cycle time, active part, and assigned operator
    await db.query(
      'UPDATE machines SET target = ?, ideal_cycle_time = ?, active_part_name = ?, assigned_operator = ? WHERE id = ?',
      [numTarget, numCycleTime, partName, operator, machineId]
    );

    // 2. Fetch current status of machine to trigger status change broadcast
    const [machines] = await db.query('SELECT status FROM machines WHERE id = ?', [machineId]);
    const status = machines.length > 0 ? machines[0].status : 'Running';

    // 3. Trigger OEE update broadcast
    await handleStatusMessage(machineId, status);

    res.json({ success: true, message: `Production plan updated for CNC machine ${machineId}` });
  } catch (err) {
    console.error(`PPC Planning Error for ${machineId}:`, err.message);
    res.status(500).json({ error: 'Failed to update CNC machine plan' });
  }
});

/**
 * Fetch all user profiles for CRUD management
 */
router.get('/users', async (req, res) => {
  try {
    const [users] = await db.query('SELECT * FROM users');
    res.json(users);
  } catch (err) {
    console.error('API Error: GET /users:', err.message);
    res.status(500).json({ error: 'Failed to retrieve user profiles list' });
  }
});

/**
 * Create a new user profile
 */
router.post('/users', async (req, res) => {
  const { loginId, role, displayName, terminalId } = req.body;
  if (!loginId || !role || !displayName || !terminalId) {
    return res.status(400).json({ error: 'loginId, role, displayName, and terminalId are required' });
  }
  try {
    await db.query(
      'INSERT INTO users (loginId, role, displayName, terminalId) VALUES (?, ?, ?, ?)',
      [loginId.trim().toUpperCase(), role.trim(), displayName.trim(), terminalId.trim()]
    );
    res.json({ success: true, message: `User profile ${loginId} created successfully` });
  } catch (err) {
    console.error('API Error: POST /users:', err.message);
    res.status(550).json({ error: 'Failed to create user profile' });
  }
});

/**
 * Update an existing user profile
 */
router.put('/users/:loginId', async (req, res) => {
  const loginId = req.params.loginId;
  const { role, displayName, terminalId } = req.body;
  if (!role || !displayName || !terminalId) {
    return res.status(400).json({ error: 'role, displayName, and terminalId are required' });
  }
  try {
    await db.query(
      'UPDATE users SET role = ?, displayName = ?, terminalId = ? WHERE loginId = ?',
      [role.trim(), displayName.trim(), terminalId.trim(), loginId]
    );
    res.json({ success: true, message: `User profile ${loginId} updated successfully` });
  } catch (err) {
    console.error('API Error: PUT /users:', err.message);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

/**
 * Delete a user profile
 */
router.delete('/users/:loginId', async (req, res) => {
  const loginId = req.params.loginId;
  try {
    await db.query('DELETE FROM users WHERE loginId = ?', [loginId]);
    res.json({ success: true, message: `User profile ${loginId} deleted successfully` });
  } catch (err) {
    console.error('API Error: DELETE /users:', err.message);
    res.status(500).json({ error: 'Failed to delete user profile' });
  }
});

export default router;
