import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'monitor.db'));
db.pragma('journal_mode = WAL');

export const DEFAULT_PROMPT = 'Say "hello" and nothing else.';

/**
 * 端到端吞吐（avg_tps = completion_tokens / total_ms）的物理上限，超出即判定为异常。
 *
 * 定这个值的依据（对现有库 1068 条 ok 记录实测）：
 *   - 可信样本(valid=1) 的 avg_tps: p99=204, max=631，超过 1000 的有 0 条
 *   - 各"干净"模型实测上限约 190
 *   - 缓存命中 / 批量重放样本普遍在 1000 以上（最高 12244）
 * 即：1000 对正常数据零误伤，但能挡住缓存类污染。
 */
export const AVG_TPS_MAX = 1000;

// ---------- 建表与迁移（v2：供应商 → 模型 两级结构） ----------

function migrate() {
  const hasProviders = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'")
    .get();
  if (hasProviders) return;

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE providers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        max_tokens INTEGER NOT NULL DEFAULT 256,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        probe_gap_ms INTEGER NOT NULL DEFAULT 5000,
        interval_minutes INTEGER NOT NULL DEFAULT 30,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const cols = db.prepare('PRAGMA table_info(models)').all().map((c) => c.name);
    if (cols.length && cols.includes('base_url')) {
      // 旧版单表 models（内嵌 base_url/api_key）→ 拆分为 供应商 + 模型
      db.exec(`
        CREATE TABLE models_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          UNIQUE(provider_id, model)
        );
      `);
      const old = db.prepare('SELECT * FROM models ORDER BY id').all();
      const insProvider = db.prepare(
        `INSERT INTO providers (name, base_url, api_key, prompt, max_tokens, timeout_ms, interval_minutes, enabled, created_at, updated_at)
         VALUES (@name, @base_url, @api_key, @prompt, @max_tokens, @timeout_ms, @interval_minutes, @enabled, @created_at, @created_at)`
      );
      const insModel = db.prepare(
        'INSERT INTO models_new (id, provider_id, model, enabled, created_at) VALUES (@id, @provider_id, @model, @enabled, @created_at)'
      );
      const providerIdByKey = new Map();
      for (const m of old) {
        const key = `${m.base_url}\u0000${m.api_key}`;
        if (!providerIdByKey.has(key)) {
          const info = insProvider.run({
            name: m.name || '未命名供应商',
            base_url: m.base_url,
            api_key: m.api_key ?? '',
            prompt: m.prompt || DEFAULT_PROMPT,
            max_tokens: m.max_tokens ?? 256,
            timeout_ms: m.timeout_ms ?? 60000,
            interval_minutes: m.interval_minutes ?? 30,
            enabled: m.enabled ?? 1,
            created_at: m.created_at,
          });
          providerIdByKey.set(key, info.lastInsertRowid);
        }
        insModel.run({
          id: m.id,
          provider_id: providerIdByKey.get(key),
          model: m.model,
          enabled: m.enabled ?? 1,
          created_at: m.created_at,
        });
      }
      db.exec('DROP TABLE models');
      db.exec('ALTER TABLE models_new RENAME TO models');
    } else {
      db.exec(`
        CREATE TABLE IF NOT EXISTS models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1,
          thinking_strength TEXT NOT NULL DEFAULT 'default',
          created_at TEXT NOT NULL,
          UNIQUE(provider_id, model)
        );
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS probe_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        valid INTEGER NOT NULL DEFAULT 1,
        ttft_ms INTEGER,
        total_ms INTEGER,
        completion_tokens INTEGER,
        estimated INTEGER NOT NULL DEFAULT 0,
        tps REAL,
        avg_tps REAL,
        reasoning_tokens INTEGER,
        reasoning_ms INTEGER,
        reasoning_tps REAL,
        content_tokens INTEGER,
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
  });
  tx();
  db.pragma('foreign_keys = ON');
}
migrate();

// 旧库升级：providers 补充 probe_gap_ms 列（同供应商内相邻两次探测的最小间隔）
{
  const pcols = db.prepare('PRAGMA table_info(providers)').all().map((c) => c.name);
  if (pcols.length && !pcols.includes('probe_gap_ms')) {
    db.exec('ALTER TABLE providers ADD COLUMN probe_gap_ms INTEGER NOT NULL DEFAULT 5000');
  }
}

// 旧库升级：models 补充 thinking_strength 列；probe_results 补充思考/输出拆分指标列
{
  const mcols = db.prepare('PRAGMA table_info(models)').all().map((c) => c.name);
  if (mcols.length && !mcols.includes('thinking_strength')) {
    db.exec("ALTER TABLE models ADD COLUMN thinking_strength TEXT NOT NULL DEFAULT 'default'");
  }
  if (mcols.length && !mcols.includes('display_name')) {
    db.exec("ALTER TABLE models ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  const rcols = db.prepare('PRAGMA table_info(probe_results)').all().map((c) => c.name);
  if (rcols.length) {
    if (!rcols.includes('valid')) {
      db.exec('ALTER TABLE probe_results ADD COLUMN valid INTEGER NOT NULL DEFAULT 1');
      // 回填历史异常：错误记录、以及 tps 缺失或超出物理上限(>5000)的成功记录标记为无效并清空 tps
      db.exec("UPDATE probe_results SET valid=0 WHERE status='error'");
      db.exec("UPDATE probe_results SET valid=0, tps=NULL WHERE status='ok' AND (tps IS NULL OR tps > 5000)");
    }
    for (const [col, def] of [
      ['reasoning_tokens', 'INTEGER'],
      ['reasoning_ms', 'INTEGER'],
      ['reasoning_tps', 'REAL'],
      ['content_tokens', 'INTEGER'],
    ]) {
      if (!rcols.includes(col)) {
        db.exec(`ALTER TABLE probe_results ADD COLUMN ${col} ${def}`);
      }
    }
  }
}

// 主指标切换为 avg_tps 后的历史回填。幂等，可重复执行。
{
  const rcols = db.prepare('PRAGMA table_info(probe_results)').all().map((c) => c.name);
  if (rcols.includes('avg_tps')) {
    // 1) 吞吐超出物理上限的（缓存命中 / 汇总回放）清空数值
    db.exec(
      `UPDATE probe_results SET avg_tps = NULL
       WHERE status = 'ok' AND avg_tps IS NOT NULL AND avg_tps > ${AVG_TPS_MAX}`
    );
    // 2) valid 的语义改为「端到端吞吐 avg_tps 是否可信」。
    //    status='ok' 已隐含「拿到了可见输出」（prober 仅在 firstContentTs !== null 时返回 ok），
    //    因此只需看 avg_tps 是否存在。旧的「可见输出窗口 >=100ms」判据不再参与。
    db.exec(`UPDATE probe_results SET valid = CASE WHEN avg_tps IS NULL THEN 0 ELSE 1 END WHERE status = 'ok'`);
  }
}

// ---------- 供应商 ----------

/**
 * 供应商列表（对外视图）：不含 api_key 明文。
 *
 * 只回传 api_key_masked（首尾各留 4 位，中间以 • 代替）与 has_api_key 标志。
 * 前端编辑时若把密钥留空即表示「不修改」，因此无需把明文回传给浏览器。
 */
export function listProviders() {
  return db
    .prepare(
      `SELECT id, name, base_url, prompt, max_tokens, timeout_ms, interval_minutes,
              probe_gap_ms, enabled, created_at, updated_at, api_key
       FROM providers ORDER BY id`
    )
    .all()
    .map(({ api_key, ...rest }) => ({
      ...rest,
      api_key_masked: maskApiKey(api_key),
      has_api_key: Boolean(api_key),
    }));
}

/** 密钥掩码：保留首尾各 4 位；过短的密钥整体隐藏 */
export function maskApiKey(key) {
  const s = typeof key === 'string' ? key : '';
  if (!s) return '';
  if (s.length <= 10) return '•'.repeat(Math.max(s.length, 4));
  return `${s.slice(0, 4)}${'•'.repeat(6)}${s.slice(-4)}`;
}

export function getProvider(id) {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
}

export function createProvider(p) {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO providers (name, base_url, api_key, prompt, max_tokens, timeout_ms, interval_minutes, probe_gap_ms, enabled, created_at, updated_at)
       VALUES (@name, @base_url, @api_key, @prompt, @max_tokens, @timeout_ms, @interval_minutes, @probe_gap_ms, @enabled, @now, @now)`
    )
    .run({ ...p, now });
  return getProvider(info.lastInsertRowid);
}

const PROVIDER_FIELDS = ['name', 'base_url', 'api_key', 'prompt', 'max_tokens', 'timeout_ms', 'interval_minutes', 'probe_gap_ms', 'enabled'];

export function updateProvider(id, patch) {
  const sets = [];
  const params = { id, updated_at: new Date().toISOString() };
  for (const k of PROVIDER_FIELDS) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = @${k}`);
      params[k] = patch[k];
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE providers SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
  }
  return getProvider(id);
}

export function deleteProvider(id) {
  db.prepare('DELETE FROM providers WHERE id = ?').run(id);
}

// ---------- 模型 ----------

/** 模型视图：联供应商展示字段（列表 / 仪表盘 / 记录页用） */
export function listModelsView() {
  return db
    .prepare(
      `SELECT m.id, m.provider_id, m.model, m.display_name, m.enabled, m.thinking_strength, m.created_at,
              p.name AS provider_name, p.base_url, p.enabled AS provider_enabled, p.interval_minutes
       FROM models m JOIN providers p ON p.id = m.provider_id
       ORDER BY p.id, m.id`
    )
    .all();
}

export function getModelRow(id) {
  return db.prepare('SELECT * FROM models WHERE id = ?').get(id);
}

/** 探测配置：模型行 + 所属供应商参数合成扁平对象，供 prober 使用 */
export function getModelConfig(id) {
  return db
    .prepare(
      `SELECT m.id, m.provider_id, m.model, m.enabled, m.thinking_strength,
              p.base_url, p.api_key, p.prompt, p.max_tokens, p.timeout_ms, p.enabled AS provider_enabled
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE m.id = ?`
    )
    .get(id);
}

export function addModel(providerId, model, thinkingStrength = 'default', displayName = '') {
  const info = db
    .prepare(
      'INSERT INTO models (provider_id, model, display_name, enabled, thinking_strength, created_at) VALUES (?, ?, ?, 1, ?, ?)'
    )
    .run(providerId, model, displayName, thinkingStrength, new Date().toISOString());
  return getModelRow(info.lastInsertRowid);
}

const MODEL_FIELDS = ['display_name', 'enabled', 'thinking_strength'];

export function updateModel(id, patch) {
  const sets = [];
  const params = { id };
  for (const k of MODEL_FIELDS) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = @${k}`);
      params[k] = k === 'enabled' ? (patch[k] ? 1 : 0) : patch[k];
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  return getModelRow(id);
}

export function deleteModel(id) {
  db.prepare('DELETE FROM models WHERE id = ?').run(id);
}

// ---------- 探测记录 ----------

export function insertProbeResult(r) {
  const created_at = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO probe_results (model_id, status, valid, ttft_ms, total_ms, completion_tokens, estimated, tps, avg_tps, reasoning_tokens, reasoning_ms, reasoning_tps, content_tokens, prompt_tokens, error_type, error_message, created_at)
       VALUES (@model_id, @status, @valid, @ttft_ms, @total_ms, @completion_tokens, @estimated, @tps, @avg_tps, @reasoning_tokens, @reasoning_ms, @reasoning_tps, @content_tokens, @prompt_tokens, @error_type, @error_message, @created_at)`
    )
    .run({ ...r, created_at });
  return { id: info.lastInsertRowid, created_at };
}

export function latestProbe(modelId) {
  return db
    .prepare('SELECT * FROM probe_results WHERE model_id = ? ORDER BY id DESC LIMIT 1')
    .get(modelId);
}

export function listProbes({ modelId, status, valid, since, limit = 100, offset = 0, order = 'desc' }) {
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
  if (valid === 1 || valid === 0) {
    where.push('valid = @valid');
    params.valid = valid;
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

// ---------- 设置 ----------

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
