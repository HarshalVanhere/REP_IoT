import db from '../config/db.js';

// Predefined downtime reasons for validation and aggregation
export const PREDEFINED_REASONS = [
  'Tea Break',
  'Lunch Break',
  'Tool Wear / Replacement',
  'Measure and Adjustment',
  'No Power',
  'Material Shortage',
  'Mechanical Jam / Fault',
  'Machine Breakdown',
  'Startup',
  'Speed Loss',
  'Defect / Rework',
  'Line Organisation',
  'Setup / Calibration',
  'No Plan',
  'NPD Trails',
  'Preventive Maintenance',
  'Operator Break',
  'Unplanned Meeting',
  'Other'
];

/**
 * Returns planned break intervals for today
 */
export function getPlannedBreaks(midnight) {
  const breaks = [];
  
  // Shift C Break: Tea (03:00 - 03:20)
  breaks.push({
    start: new Date(midnight.getTime() + 3 * 3600000),
    end: new Date(midnight.getTime() + (3 * 3600000 + 20 * 60000))
  });
  
  // Shift A Breaks: Tea (10:00 - 10:20), Lunch (12:30 - 13:00)
  breaks.push({
    start: new Date(midnight.getTime() + 10 * 3600000),
    end: new Date(midnight.getTime() + (10 * 3600000 + 20 * 60000))
  });
  breaks.push({
    start: new Date(midnight.getTime() + 12.5 * 3600000),
    end: new Date(midnight.getTime() + 13 * 3600000)
  });
  
  // Shift B Breaks: Tea (18:30 - 18:50), Dinner (20:30 - 21:00)
  breaks.push({
    start: new Date(midnight.getTime() + 18.5 * 3600000),
    end: new Date(midnight.getTime() + (18.5 * 3600000 + 20 * 60000))
  });
  breaks.push({
    start: new Date(midnight.getTime() + 20.5 * 3600000),
    end: new Date(midnight.getTime() + 21 * 3600000)
  });
  
  return breaks;
}

/**
 * Calculates net planned production seconds elapsed since midnight (excluding breaks)
 */
export function getPlannedProductionSeconds(now) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  
  const elapsedSeconds = (now.getTime() - midnight.getTime()) / 1000;
  let plannedSeconds = 0;
  
  // 1. Evaluate Shift C (00:00 - 07:00)
  if (elapsedSeconds <= 7 * 3600) {
    plannedSeconds = elapsedSeconds;
    // Subtract C Tea Break (03:00 - 03:20)
    const breakStart = 3 * 3600;
    const breakEnd = 3 * 3600 + 20 * 60;
    if (elapsedSeconds > breakEnd) {
      plannedSeconds -= 20 * 60;
    } else if (elapsedSeconds > breakStart) {
      plannedSeconds -= (elapsedSeconds - breakStart);
    }
  } else {
    // Shift C is fully completed (420 mins total - 20 mins break = 400 mins)
    plannedSeconds += 400 * 60;
    
    // 2. Evaluate Shift A (07:00 - 15:30)
    if (elapsedSeconds <= 15.5 * 3600) {
      const shiftAElapsed = elapsedSeconds - 7 * 3600;
      plannedSeconds += shiftAElapsed;
      
      // Subtract A Tea Break (10:00 - 10:20)
      const teaStart = 3 * 3600; // 3 hours past 07:00
      const teaEnd = 3 * 3600 + 20 * 60;
      if (shiftAElapsed > teaEnd) {
        plannedSeconds -= 20 * 60;
      } else if (shiftAElapsed > teaStart) {
        plannedSeconds -= (shiftAElapsed - teaStart);
      }
      
      // Subtract A Lunch Break (12:30 - 13:00)
      const lunchStart = 5.5 * 3600; // 5.5 hours past 07:00
      const lunchEnd = 6 * 3600;
      if (shiftAElapsed > lunchEnd) {
        plannedSeconds -= 30 * 60;
      } else if (shiftAElapsed > lunchStart) {
        plannedSeconds -= (shiftAElapsed - lunchStart);
      }
    } else {
      // Shift A is fully completed (510 mins total - 50 mins breaks = 460 mins)
      plannedSeconds += 460 * 60;
      
      // 3. Evaluate Shift B (15:30 - 24:00)
      const shiftBElapsed = elapsedSeconds - 15.5 * 3600;
      plannedSeconds += shiftBElapsed;
      
      // Subtract B Tea Break (18:30 - 18:50)
      const teaStart = 3 * 3600; // 3 hours past 15:30
      const teaEnd = 3 * 3600 + 20 * 60;
      if (shiftBElapsed > teaEnd) {
        plannedSeconds -= 20 * 60;
      } else if (shiftBElapsed > teaStart) {
        plannedSeconds -= (shiftBElapsed - teaStart);
      }
      
      // Subtract B Dinner Break (20:30 - 21:00)
      const dinnerStart = 5 * 3600; // 5 hours past 15:30
      const dinnerEnd = 5.5 * 3600;
      if (shiftBElapsed > dinnerEnd) {
        plannedSeconds -= 30 * 60;
      } else if (shiftBElapsed > dinnerStart) {
        plannedSeconds -= (shiftBElapsed - dinnerStart);
      }
    }
  }
  
  return Math.max(1, plannedSeconds);
}

/**
 * Calculates overlap in seconds between two date intervals
 */
function getIntervalOverlapSeconds(start1, end1, start2, end2) {
  const s = Math.max(start1.getTime(), start2.getTime());
  const e = Math.min(end1.getTime(), end2.getTime());
  return Math.max(0, (e - s) / 1000);
}

/**
 * Calculates Availability, Performance, Quality, OEE, shifts count,
 * machine utilization, downtime reasons, and last cycle time.
 */
export async function calculateOEE(machineId) {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  try {
    // 1. Fetch machine details
    const [machines] = await db.query('SELECT * FROM machines WHERE id = ?', [machineId]);
    if (machines.length === 0) {
      throw new Error(`Machine ${machineId} not found`);
    }
    const machine = machines[0];
    const idealCycleTime = machine.ideal_cycle_time;
    const totalCount = machine.production_count;
    const goodCount = machine.good_count;

    // 2. Fetch status logs from midnight
    const [logs] = await db.query(
      'SELECT status, start_time, end_time, downtime_reason FROM status_logs WHERE machine_id = ? AND (end_time IS NULL OR end_time >= ?)',
      [machineId, midnight]
    );

    // 3. Fetch pulses since midnight
    const [pulses] = await db.query(
      'SELECT timestamp, cycle_time, is_good FROM pulses WHERE machine_id = ? AND timestamp >= ?',
      [machineId, midnight]
    );

    // 4. Calculate last cycle time
    let lastCycleTime = 0;
    if (pulses.length > 0) {
      lastCycleTime = parseFloat(pulses[pulses.length - 1].cycle_time || 0);
    }

    // 5. Shift-wise production count (A, B, C)
    let shiftA = 0;
    let shiftB = 0;
    let shiftC = 0;

    pulses.forEach(pulse => {
      const pulseTime = new Date(pulse.timestamp);
      const hour = pulseTime.getHours();
      const minute = pulseTime.getMinutes();
      const minutesSinceMidnight = hour * 60 + minute;
      
      if (minutesSinceMidnight >= 7 * 60 && minutesSinceMidnight < 15.5 * 60) {
        shiftA++;
      } else if (minutesSinceMidnight >= 15.5 * 60 && minutesSinceMidnight < 24 * 60) {
        shiftB++;
      } else {
        shiftC++;
      }
    });

    // 6. Calculate durations for utilization (Running, Stopped, No Signal)
    let runningSeconds = 0;
    let stoppedSeconds = 0;
    let noSignalSeconds = 0;

    // Aggregate downtime by reason
    const downtimeReasons = {};
    PREDEFINED_REASONS.forEach(r => downtimeReasons[r] = 0);

    const todayBreaks = getPlannedBreaks(midnight);

    logs.forEach(log => {
      const logStart = new Date(Math.max(new Date(log.start_time).getTime(), midnight.getTime()));
      const logEnd = log.end_time ? new Date(Math.min(new Date(log.end_time).getTime(), now.getTime())) : now;
      let durationSeconds = Math.max(0, (logEnd.getTime() - logStart.getTime()) / 1000);

      // Subtract any planned break overlap so operators are not penalized for lunch/tea breaks
      todayBreaks.forEach(b => {
        const overlap = getIntervalOverlapSeconds(logStart, logEnd, b.start, b.end);
        durationSeconds -= overlap;
      });

      if (log.status === 'Running') {
        runningSeconds += durationSeconds;
      } else if (log.status === 'Stopped') {
        stoppedSeconds += durationSeconds;
        // Group by reason if available
        const reason = log.downtime_reason || 'Other';
        if (downtimeReasons[reason] !== undefined) {
          downtimeReasons[reason] += durationSeconds;
        } else {
          downtimeReasons['Other'] += durationSeconds;
        }
      } else if (log.status === 'No Signal') {
        noSignalSeconds += durationSeconds;
      }
    });

    // Planned production seconds today
    const plannedSeconds = getPlannedProductionSeconds(now);

    const runningPct = Math.max(0, Math.min(100, (runningSeconds / plannedSeconds) * 100));
    const stoppedPct = Math.max(0, Math.min(100, (stoppedSeconds / plannedSeconds) * 100));
    const noSignalPct = Math.max(0, Math.min(100, (noSignalSeconds / plannedSeconds) * 100));

    // Availability = (Planned Time - Actual Downtime) / Planned Time
    const totalDowntimeSeconds = stoppedSeconds + noSignalSeconds;
    let operatingTimeSeconds = plannedSeconds - totalDowntimeSeconds;
    if (operatingTimeSeconds < 0) operatingTimeSeconds = 0;

    let availability = plannedSeconds > 0 
      ? (operatingTimeSeconds / plannedSeconds) * 100 
      : 100;
    availability = Math.max(0, Math.min(100, availability));

    // Performance = (Parts Produced * Ideal Cycle Time) / Operating Time
    let performance = 100;
    if (operatingTimeSeconds > 0) {
      performance = ((totalCount * idealCycleTime) / operatingTimeSeconds) * 100;
      performance = Math.max(0, Math.min(100, performance));
    } else {
      performance = totalCount > 0 ? 100 : 0;
    }

    // Quality = Good Parts / Total Parts
    let quality = 100;
    if (totalCount > 0) {
      quality = (goodCount / totalCount) * 100;
      quality = Math.max(0, Math.min(100, quality));
    }

    // Overall OEE
    const oee = (availability / 100) * (performance / 100) * (quality / 100) * 100;

    // Determine current active shift
    const nowHour = now.getHours();
    const nowMinute = now.getMinutes();
    const nowMinutes = nowHour * 60 + nowMinute;
    
    let currentShift = 'Shift C';
    if (nowMinutes >= 7 * 60 && nowMinutes < 15.5 * 60) {
      currentShift = 'Shift A';
    } else if (nowMinutes >= 15.5 * 60 && nowMinutes < 24 * 60) {
      currentShift = 'Shift B';
    }

    return {
      availability: parseFloat(availability.toFixed(1)),
      performance: parseFloat(performance.toFixed(1)),
      quality: parseFloat(quality.toFixed(1)),
      oee: parseFloat(oee.toFixed(1)),
      downtimeSeconds: Math.round(totalDowntimeSeconds),
      lastCycleTime,
      currentShift,
      shifts: {
        A: shiftA,
        B: shiftB,
        C: shiftC
      },
      utilization: {
        Running: parseFloat(runningPct.toFixed(1)),
        Stopped: parseFloat(stoppedPct.toFixed(1)),
        NoSignal: parseFloat(noSignalPct.toFixed(1))
      },
      downtimeReasons: Object.keys(downtimeReasons).reduce((acc, key) => {
        acc[key] = Math.round(downtimeReasons[key]);
        return acc;
      }, {})
    };
  } catch (error) {
    console.error(`Error calculating OEE for machine ${machineId}:`, error.message);
    return {
      availability: 100,
      performance: 0,
      quality: 100,
      oee: 0,
      downtimeSeconds: 0,
      lastCycleTime: 0,
      currentShift: 'Shift A',
      shifts: { A: 0, B: 0, C: 0 },
      utilization: { Running: 100, Stopped: 0, NoSignal: 0 },
      downtimeReasons: {}
    };
  }
}
