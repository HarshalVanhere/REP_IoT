import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({host:'tokaido.proxy.rlwy.net',port:36659,user:'root',password:'zAzyuBJzQEijUqCZxkIHfAFaCoyeNtCh',database:'railway'});
const [rows] = await conn.query(`
  SELECT id, status, start_time, end_time, downtime_reason
  FROM status_logs
  WHERE machine_id = '1313' AND start_time >= '2026-08-04 01:30:00'
  ORDER BY start_time
`);
rows.forEach(r => console.log(r.id, r.status, r.start_time, r.end_time, JSON.stringify(r.downtime_reason)));
await conn.end();
