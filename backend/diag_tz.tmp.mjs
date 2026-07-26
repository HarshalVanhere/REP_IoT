import db from './src/config/db.js';

async function main() {
  const [rows] = await db.query("SELECT NOW() as db_now, UTC_TIMESTAMP() as db_utc_now, @@session.time_zone as session_tz, @@global.time_zone as global_tz");
  console.log('JS Date.now() (Node process, UTC ISO):', new Date().toISOString());
  console.log('DB query result:', rows[0]);

  // Round-trip test: insert a JS Date "now" into a TIMESTAMP column-shaped temp table and read it back
  await db.query("CREATE TEMPORARY TABLE tz_probe (t TIMESTAMP NULL)");
  const jsNow = new Date();
  await db.query("INSERT INTO tz_probe (t) VALUES (?)", [jsNow]);
  const [probe] = await db.query("SELECT t, UTC_TIMESTAMP() as db_utc_now_after FROM tz_probe");
  console.log('JS Date inserted (ISO):', jsNow.toISOString());
  console.log('Read back from TIMESTAMP column:', probe[0].t, '(as ISO:', new Date(probe[0].t).toISOString(), ')');
  console.log('DB UTC_TIMESTAMP at time of read:', probe[0].db_utc_now_after);

  process.exit(0);
}
main().catch(e => { console.error('ERROR', e); process.exit(1); });
