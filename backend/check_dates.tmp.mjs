import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({host:'tokaido.proxy.rlwy.net',port:36659,user:'root',password:'zAzyuBJzQEijUqCZxkIHfAFaCoyeNtCh',database:'railway'});
const [rows] = await conn.query(`
  SELECT DATE(start_time) d, downtime_reason, COUNT(*) c
  FROM status_logs
  WHERE downtime_reason IS NOT NULL AND DATE(start_time) IN ('2026-08-03','2026-08-04')
  GROUP BY DATE(start_time), downtime_reason
  ORDER BY d, c DESC
`);
rows.forEach(r => console.log(r.d, JSON.stringify(r.downtime_reason), r.c));
await conn.end();
