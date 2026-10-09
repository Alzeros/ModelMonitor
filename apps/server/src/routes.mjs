import {
  DEFAULT_PROMPT,
  createModel,
  db,
  deleteModel,
  getModel,
  getSettings,
  latestProbe,
  listModels,
  listProbes,
  setSetting,
  updateModel,
} from './db.mjs';
import { probeModel } from './prober.mjs';
import { reloadScheduler, runManualProbe } from './scheduler.mjs';

const RANGE_MS = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

const DEFAULT_SETTINGS = {
  default_interval_minutes: '30',
};

function toInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeBaseUrl(u) {
  return String(u).trim().replace(/\/+$/, '');
}

/** 全量校验并归一化模型字段（PUT 时先用现有记录 merge 再传入） */
function parseModelBody(body, { requireName = true } = {}) {
  const b = body ?? {};
  const errors = [];
  const out = {};

  if (requireName) {
    if (typeof b.name === 'string' && b.name.trim()) out.name = b.name.trim();
    else errors.push('名称必填');
  } else if (typeof b.name === 'string' && b.name.trim()) {
    out.name = b.name.trim();
  }

  if (typeof b.base_url === 'string' && b.base_url.trim()) {
    const u = b.base_url.trim();
    if (/^https?:\/\//i.test(u)) out.base_url = normalizeBaseUrl(u);
    else errors.push('Base URL 必须以 http(s):// 开头');
  } else {
    errors.push('Base URL 必填');
  }

  out.api_key = typeof b.api_key === 'string' ? b.api_key : '';

  if (typeof b.model === 'string' && b.model.trim()) out.model = b.model.trim();
  else errors.push('模型 ID 必填');

  if (typeof b.prompt === 'string' && b.prompt.trim()) out.prompt = b.prompt;
  else out.prompt = DEFAULT_PROMPT;

  out.max_tokens = toInt(b.max_tokens, 256, 1, 65536);
  out.timeout_ms = toInt(b.timeout_ms, 60000, 1000, 600000);
  out.interval_minutes = toInt(b.interval_minutes, 30, 1, 10080);
  out.enabled = b.enabled === undefined ? 1 : (b.enabled ? 1 : 0);

  return { out, errors };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function summarize(rows) {
  const total = rows.length;
  const okRows = rows.filter((r) => r.status === 'ok');
  const tps = okRows.map((r) => r.tps).filter((v) => v != null).sort((a, b) => a - b);
  const ttft = okRows.map((r) => r.ttft_ms).filter((v) => v != null).sort((a, b) => a - b);
  const totalMs = okRows.map((r) => r.total_ms).filter((v) => v != null).sort((a, b) => a - b);
  const avg = (arr) => (arr.length ? round2(arr.reduce((s, v) => s + v, 0) / arr.length) : null);
  return {
    total,
    ok_count: okRows.length,
    error_count: total - okRows.length,
    success_rate: total ? Math.round((okRows.length / total) * 1000) / 10 : null,
    tps: { avg: avg(tps), p50: round2(percentile(tps, 0.5)), p95: round2(percentile(tps, 0.95)), max: tps.length ? tps[tps.length - 1] : null },
    ttft_ms: { avg: avg(ttft), p50: percentile(ttft, 0.5) != null ? Math.round(percentile(ttft, 0.5)) : null, p95: percentile(ttft, 0.95) != null ? Math.round(percentile(ttft, 0.95)) : null },
    total_ms: { avg: avg(totalMs) },
  };
}

export async function registerRoutes(app) {
  // ---------- 模型 ----------
  app.get('/api/models', async () => {
    const models = listModels().map((m) => ({ ...m, latest: latestProbe(m.id) }));
    return { items: models };
  });

  app.get('/api/models/:id', async (req, reply) => {
    const model = getModel(Number(req.params.id));
    if (!model) return reply.code(404).send({ error: 'model not found' });
    return model;
  });

  app.post('/api/models', async (req, reply) => {
    const { out, errors } = parseModelBody(req.body);
    if (errors.length) return reply.code(400).send({ errors });
    const model = createModel(out);
    reloadScheduler();
    return reply.code(201).send(model);
  });

  app.put('/api/models/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getModel(id);
    if (!existing) return reply.code(404).send({ error: 'model not found' });
    const { out, errors } = parseModelBody({ ...existing, ...req.body });
    if (errors.length) return reply.code(400).send({ errors });
    const model = updateModel(id, out);
    reloadScheduler();
    return model;
  });

  app.delete('/api/models/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getModel(id);
    if (!existing) return reply.code(404).send({ error: 'model not found' });
    deleteModel(id);
    reloadScheduler();
    return { ok: true };
  });

  // ---------- 探测 ----------
  app.post('/api/models/:id/probe', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getModel(id)) return reply.code(404).send({ error: 'model not found' });
    const result = await runManualProbe(id);
    if (result?.error === 'probe_running') return reply.code(409).send({ error: '探测正在进行中，请稍后' });
    return result;
  });

  app.post('/api/probe-test', async (req, reply) => {
    const b = req.body ?? {};
    const { out, errors } = parseModelBody(b, { requireName: false });
    if (errors.length) return reply.code(400).send({ errors });
    const cfg = {
      id: null,
      base_url: out.base_url,
      api_key: out.api_key,
      model: out.model,
      prompt: out.prompt,
      max_tokens: toInt(b.max_tokens, 64, 1, 65536),
      timeout_ms: toInt(b.timeout_ms, 30000, 1000, 600000),
    };
    return await probeModel(cfg, { persist: false });
  });

  // ---------- 指标 ----------
  app.get('/api/models/:id/summary', async (req, reply) => {
    const model = getModel(Number(req.params.id));
    if (!model) return reply.code(404).send({ error: 'model not found' });
    const range = String(req.query.range ?? '24h');
    const ms = RANGE_MS[range];
    if (!ms) return reply.code(400).send({ error: `range 必须是 ${Object.keys(RANGE_MS).join('/')}` });
    const since = new Date(Date.now() - ms).toISOString();
    const rows = db
      .prepare('SELECT * FROM probe_results WHERE model_id = ? AND created_at >= ? ORDER BY created_at ASC')
      .all(model.id, since);
    return { model_id: model.id, range, latest: latestProbe(model.id), stats: summarize(rows) };
  });

  app.get('/api/probes', async (req) => {
    const q = req.query ?? {};
    const range = q.range ? RANGE_MS[String(q.range)] : undefined;
    const since = range ? new Date(Date.now() - range).toISOString() : undefined;
    const limit = toInt(q.limit, 100, 1, 1000);
    const offset = toInt(q.offset, 0, 0, 1_000_000_000);
    return listProbes({
      modelId: q.model_id != null && q.model_id !== '' ? Number(q.model_id) : null,
      status: q.status === 'ok' || q.status === 'error' ? q.status : undefined,
      since,
      limit,
      offset,
      order: q.order === 'asc' ? 'asc' : 'desc',
    });
  });

  // ---------- 设置 ----------
  app.get('/api/settings', async () => ({
    ...DEFAULT_SETTINGS,
    ...getSettings(),
  }));

  app.put('/api/settings', async (req) => {
    const b = req.body ?? {};
    if (b.default_interval_minutes !== undefined) {
      setSetting('default_interval_minutes', String(toInt(b.default_interval_minutes, 30, 1, 10080)));
    }
    return { ...DEFAULT_SETTINGS, ...getSettings() };
  });
}
