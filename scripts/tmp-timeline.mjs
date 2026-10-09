import { db } from '../apps/server/src/db.mjs';

const now = Date.now();
console.log('now:', new Date(now).toISOString());

// 每个模型最近 4 条记录
const rows = db
  .prepare(
    `SELECT r.*, m.model, p.name AS pname
     FROM probe_results r
     JOIN models m ON m.id = r.model_id
     JOIN providers p ON p.id = m.provider_id
     ORDER BY r.id DESC LIMIT 40`
  )
  .all();

const line = rows
  .slice()
  .reverse()
  .map((r) => {
    const dt = new Date(r.created_at).toISOString();
    const ago = Math.round((now - new Date(r.created_at).getTime()) / 60000);
    return `${dt} (-${ago}m) [${r.pname}] ${r.model}: ${r.status}${r.error_type ? '/' + r.error_type : ''} total=${r.total_ms ?? '-'}ms ttft=${r.ttft_ms ?? '-'}ms`;
  });
console.log(line.join('\n'));

// 按时间轴看每轮的归属：列出各 tick 的群组
console.log('\n--- 按记录时间排序（全部） ---');
for (const r of rows.slice().reverse()) {
  console.log(
    new Date(r.created_at).toISOString(),
    r.pname,
    r.model,
    r.status,
    r.error_type ?? '',
    `total=${r.total_ms ?? '-'}`
  );
}