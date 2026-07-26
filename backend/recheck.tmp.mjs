import db from './src/config/db.js';

const IST_OFFSET_MS = 5.5 * 3600000;
const toIST = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().replace('T', ' ').replace('Z', ' IST');

async function main() {
  const nodeNow = new Date();
  const [[dbClock]] = await db.query("SELECT NOW() as db_now, UTC_TIMESTAMP() as db_utc_now");

  console.log('This process\'s clock (should be true UTC):', nodeNow.toISOString(), ' -> as IST:', toIST(nodeNow));
  console.log('MySQL server\'s own UTC_TIMESTAMP():        ', dbClock.db_utc_now.toISOString(), ' -> as IST:', toIST(dbClock.db_utc_now));
  console.log('Clock skew (this process vs MySQL server):', ((nodeNow - dbClock.db_utc_now)/3600000).toFixed(2), 'hours');
  console.log('');

  const [mrow] = await db.query("SELECT id, status, last_pulse, production_count FROM machines WHERE id=?", ['1313']);
  const m = mrow[0];
  console.log('machine 1313 status:', m.status, ' production_count:', m.production_count);
  console.log('last_pulse (raw UTC):', m.last_pulse.toISOString(), ' -> as IST:', toIST(m.last_pulse));
  console.log('Age of last_pulse vs THIS process\'s clock:', ((nodeNow - m.last_pulse)/60000).toFixed(1), 'minutes');

  const [openLogs] = await db.query(
    "SELECT id, status, start_time, end_time FROM status_logs WHERE machine_id = ? AND end_time IS NULL ORDER BY start_time ASC",
    ['1313']
  );
  console.log('open status_logs:', openLogs.map(l => ({...l, start_time_ist: toIST(l.start_time)})));

  process.exit(0);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
