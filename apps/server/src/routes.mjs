import {
  DEFAULT_PROMPT,
  addModel,
  createProvider,
  db,
  deleteModel,
  deleteProvider,
  getModelConfig,
  getModelRow,
  getProvider,
  getSettings,
  latestProbe,
  listModelsView,
  listProviders,
  listProbes,
  setSetting,
  updateModel,
  updateProvider,
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

/** 思考强度归一化：default 不发送，low/high/max 注入 reasoning_effort */
function normalizeThinking(v) {
  const s = String(v ?? 'default');
  return ['default', 'low', 'high', 'max'].includes(s) ? s : 'default';
}

/** 全量校验并归一化供应商字段（PUT 时先用现有记录 merge 再传入） */
function parseProviderBody(body, { requireName = true } = {}) {
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

  if (typeof b.prompt === 'string' && b.prompt.trim()) out.prompt = b.prompt;
  else out.prompt = DEFAULT_PROMPT;

  out.max_tokens = toInt(b.max_tokens, 256, 1, 65536);
  out.timeout_ms = toInt(b.timeout_ms, 60000, 1000, 600000);
  out.interval_minutes = toInt(b.interval_minutes, 30, 1, 10080);
  out.probe_gap_ms = toInt(b.probe_gap_ms, 5000, 0, 60000);
  out.enabled = b.enabled === undefined ? 1 : (b.enabled ? 1 : 0);

  return { out, errors };
}

/** 由 base_url 计算模型列表地址；与 prober.buildChatUrl 同样兼容误粘贴完整接口地址 */
function buildModelsUrl(base) {
  const b = String(base).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return `${b}/models`;
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
  // ---------- 供应商 ----------
  app.get('/api/providers', async () => ({ items: listProviders() }));

  app.post('/api/providers', async (req, reply) => {
    const { out, errors } = parseProviderBody(req.body);
    if (errors.length) return reply.code(400).send({ errors });
    return reply.code(201).send(createProvider(out));
  });

  app.put('/api/providers/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const existing = getProvider(id);
    if (!existing) return reply.code(404).send({ error: 'provider not found' });
    const { out, errors } = parseProviderBody({ ...existing, ...req.body });
    if (errors.length) return reply.code(400).send({ errors });
    const provider = updateProvider(id, out);
    reloadScheduler();
    return provider;
  });

  app.delete('/api/providers/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getProvider(id)) return reply.code(404).send({ error: 'provider not found' });
    deleteProvider(id); // 级联删除其模型与探测记录
    reloadScheduler();
    return { ok: true };
  });

  // ---------- 模型 ----------
  app.get('/api/models', async () => {
    const items = listModelsView().map((m) => ({ ...m, latest: latestProbe(m.id) }));
    return { items };
  });

  // 批量添加模型（单个或多个）：{ models: ["id1", "id2", ...] }
  app.post('/api/providers/:id/models', async (req, reply) => {
    const provider = getProvider(Number(req.params.id));
    if (!provider) return reply.code(404).send({ error: 'provider not found' });
    const raw = req.body?.models;
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? [raw]
        : [];
    const names = [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
    if (!names.length) return reply.code(400).send({ error: '模型 ID 不能为空' });
    const thinking = normalizeThinking(req.body?.thinking_strength);
    // 显示名称仅对单模型添加生效（批量时忽略，添加后可单独改名）
    const displayName = names.length === 1 ? String(req.body?.display_name ?? '').trim().slice(0, 50) : '';
    let added = 0;
    const skipped = [];
    for (const model of names) {
      try {
        addModel(provider.id, model, thinking, displayName);
        added += 1;
      } catch {
        skipped.push(model); // UNIQUE(provider_id, model) 冲突 = 已存在
      }
    }
    reloadScheduler();
    return { added, skipped };
  });

  app.put('/api/models/:id', async (req, reply) => {
    const row = getModelRow(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'model not found' });
    const patch = {};
    if (req.body?.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
    if (req.body?.thinking_strength !== undefined) patch.thinking_strength = normalizeThinking(req.body.thinking_strength);
    if (req.body?.display_name !== undefined) patch.display_name = String(req.body.display_name).trim().slice(0, 50);
    if (!Object.keys(patch).length) return reply.code(400).send({ error: '无有效字段（enabled / thinking_strength / display_name）' });
    const model = updateModel(row.id, patch);
    reloadScheduler();
    return model;
  });

  app.delete('/api/models/:id', async (req, reply) => {
    const row = getModelRow(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'model not found' });
    deleteModel(row.id);
    reloadScheduler();
    return { ok: true };
  });

  // ---------- 探测 ----------
  app.post('/api/models/:id/probe', async (req, reply) => {
    const id = Number(req.params.id);
    if (!getModelRow(id)) return reply.code(404).send({ error: 'model not found' });
    const result = await runManualProbe(id);
    if (result?.error === 'probe_running') return reply.code(409).send({ error: '探测正在进行中，请稍后' });
    return result;
  });

  app.post('/api/probe-test', async (req, reply) => {
    const b = req.body ?? {};
    const { out, errors } = parseProviderBody(b, { requireName: false });
    if (errors.length) return reply.code(400).send({ errors });
    if (typeof b.model !== 'string' || !b.model.trim()) {
      return reply.code(400).send({ errors: ['模型 ID 必填'] });
    }
    const cfg = {
      id: null,
      base_url: out.base_url,
      api_key: out.api_key,
      model: b.model.trim(),
      prompt: out.prompt,
      max_tokens: toInt(b.max_tokens, 256, 1, 65536),
      timeout_ms: toInt(b.timeout_ms, 30000, 1000, 600000),
      thinking_strength: normalizeThinking(b.thinking_strength),
    };
    return await probeModel(cfg, { persist: false });
  });

  // 拉取供应商可用模型列表（OpenAI 兼容 GET {base}/models）
  app.post('/api/models-list', async (req, reply) => {
    const b = req.body ?? {};
    const base = typeof b.base_url === 'string' ? b.base_url.trim() : '';
    if (!/^https?:\/\//i.test(base)) {
      return reply.code(400).send({ error: 'Base URL 必填且以 http(s):// 开头' });
    }
    const key = typeof b.api_key === 'string' ? b.api_key : '';
    const candidates = [buildModelsUrl(base)];
    if (!candidates[0].includes('/v1/')) {
      candidates.push(candidates[0].replace(/\/models$/i, '/v1/models'));
    }
    let lastUrl = candidates[0];
    let res;
    try {
      for (const url of candidates) {
        lastUrl = url;
        res = await fetch(url, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 404 || res.status === 405) continue;
        break;
      }
    } catch (err) {
      const cause = err?.cause?.code ?? err?.cause?.message;
      return reply.code(502).send({ error: `网络错误 @ ${lastUrl}${cause ? ` (${cause})` : ''}` });
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const msg = `HTTP ${res.status} ${res.statusText} @ ${lastUrl}${bodyText ? `: ${bodyText.slice(0, 300)}` : ''}`;
      return reply.code(res.status === 401 || res.status === 403 ? 401 : 502).send({ error: msg });
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) {
      const bodyText = await res.text().catch(() => '');
      return reply.code(502).send({ error: `响应不是 JSON @ ${lastUrl}: ${bodyText.slice(0, 200)}` });
    }
    const data = await res.json().catch(() => null);
    let items = [];
    if (Array.isArray(data)) items = data;
    else if (Array.isArray(data?.data)) items = data.data;
    else if (Array.isArray(data?.models)) items = data.models;
    if (!items.length) {
      return reply.code(502).send({ error: `未在响应中找到模型列表 @ ${lastUrl}` });
    }
    const ids = items
      .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name ?? ''))
      .filter((s) => typeof s === 'string' && s)
      .sort((a, b) => a.localeCompare(b));
    return { items: [...new Set(ids)], url: lastUrl };
  });

  // ---------- 指标 ----------
  app.get('/api/models/:id/summary', async (req, reply) => {
    const row = getModelRow(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'model not found' });
    const range = String(req.query.range ?? '24h');
    const ms = RANGE_MS[range];
    if (!ms) return reply.code(400).send({ error: `range 必须是 ${Object.keys(RANGE_MS).join('/')}` });
    const since = new Date(Date.now() - ms).toISOString();
    const rows = db
      .prepare('SELECT * FROM probe_results WHERE model_id = ? AND created_at >= ? ORDER BY created_at ASC')
      .all(row.id, since);
    return { model_id: row.id, range, latest: latestProbe(row.id), stats: summarize(rows) };
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
      valid: q.valid === '1' ? 1 : q.valid === '0' ? 0 : undefined,
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
