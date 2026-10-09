import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'monitor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  max_tokens INTEGER NOT NULL DEFAULT 256,
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS probe_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  ttft_ms INTEGER,
  total_ms INTEGER,
  completion_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  tps REAL,
  avg_tps REAL,
  prompt_tokens INTEGER,
  error_type TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_probe_model_time ON probe_results(model_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const DEFAULT_PROMPT = 'Say "hello" and nothing else.';

export function listModels() {
  return db.prepare('SELECT * FROM models ORDER BY id').all();
}

export function getModel(id) {
  return db.prepare('SELECT * FROM models WHERE id = ?').get(id);
}

export function createModel(m) {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO models (name, base_url, api_key, model, prompt, max_tokens, timeout_ms, interval_minutes, enabled, created_at, updated_at)
       VALUES (@name, @base_url, @api_key, @model, @prompt, @max_tokens, @timeout_ms, @interval_minutes, @enabled, @now, @now)`
    )
    .run({ ...m, now });
  return getModel(info.lastInsertRowid);
}

const MODEL_FIELDS = ['name', 'base_url', 'api_key', 'model', 'prompt', 'max_tokens', 'timeout_ms', 'interval_minutes', 'enabled'];

export function updateModel(id, patch) {
  const sets = [];
  const params = { id, updated_at: new Date().toISOString() };
  for (const k of MODEL_FIELDS) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = @${k}`);
      params[k] = patch[k];
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE models SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  }
  return getModel(id);
}

export function deleteModel(id) {
  db.prepare('DELETE FROM models WHERE id = ?').run(id);
}

export function insertProbeResult(r) {
  const created_at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO probe_results (model_id, status, ttft_ms, total_ms, completion_tokens, estimated, tps, avg_tps, prompt_tokens, error_type, error_message, created_at)
       VALUES (@model_id, @status, @ttft_ms, @total_ms, @completion_tokens, @estimated, @tps, @avg_tps, @prompt_tokens, @error_type, @error_message, @created_at)`
    )
    .run({ ...r, created_at });
  return { id: info.lastInsertRowid, created_at };
}

export function latestProbe(modelId) {
  return db
    .prepare('SELECT * FROM probe_results WHERE model_id = ? ORDER BY id DESC LIMIT 1')
    .get(modelId);
}

export function listProbes({ modelId, status, since, limit = 100, offset = 0, order = 'desc' }) {
  const where = [];
  const params = { limit, offset };
  if (modelId != null) {
    where.push('model_id = @modelId');
    params.modelId = modelId;
  }
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  if (since) {
    where.push('created_at >= @since');
    params.since = since;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = order === 'asc' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM probe_results ${whereSql}`).get(params).c;
  const items = db
    .prepare(`SELECT * FROM probe_results ${whereSql} ORDER BY id ${orderSql} LIMIT @limit OFFSET @offset`)
    .all(params);
  return { total, items };
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
