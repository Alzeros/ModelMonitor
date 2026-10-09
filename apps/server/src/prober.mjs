import { DEFAULT_PROMPT, insertProbeResult } from './db.mjs';

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, '')}${suffix}`;
}

function truncate(s, n = 500) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'invalid_model';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'http_error';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function ok(metrics) {
  return { status: 'ok', ...metrics, error_type: null, error_message: null };
}

function fail(type, message) {
  return {
    status: 'error',
    ttft_ms: null,
    total_ms: null,
    completion_tokens: null,
    estimated: 0,
    tps: null,
    avg_tps: null,
    prompt_tokens: null,
    error_type: type,
    error_message: truncate(message),
  };
}

async function doFetch(model, { maxTokens, useStreamOptions, signal }) {
  return fetch(joinUrl(model.base_url, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(model.api_key ? { Authorization: `Bearer ${model.api_key}` } : {}),
    },
    body: JSON.stringify({
      model: model.model,
      messages: [{ role: 'user', content: model.prompt || DEFAULT_PROMPT }],
      max_tokens: maxTokens,
      stream: true,
      ...(useStreamOptions ? { stream_options: { include_usage: true } } : {}),
    }),
    signal,
  });
}

async function runProbe(model) {
  const timeoutMs = Math.min(600000, Math.max(1000, Number(model.timeout_ms) || 60000));
  const maxTokens = Math.min(65536, Math.max(1, Math.round(Number(model.max_tokens) || 256)));
  const t0 = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let res = await doFetch(model, { maxTokens, useStreamOptions: true, signal: controller.signal });
    // 部分兼容服务不认识 stream_options 会返回 400，去掉该参数重试一次
    if (res.status === 400) {
      res = await doFetch(model, { maxTokens, useStreamOptions: false, signal: controller.signal });
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return fail(classifyStatus(res.status), `HTTP ${res.status} ${res.statusText}${bodyText ? `: ${bodyText}` : ''}`);
    }
    if (!res.body) {
      return fail('no_response_body', '响应没有可读的流');
    }

    const decoder = new TextDecoder('utf-8');
    const reader = res.body.getReader();
    let buffer = '';
    let ttftMs = null;
    let chunkCount = 0;
    let usage = null;
    let streamEnded = false;

    while (!streamEnded) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          streamEnded = true;
          break;
        }
        let evt;
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt && typeof evt === 'object' && evt.usage && typeof evt.usage === 'object') {
          usage = evt.usage;
        }
        const content = evt?.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          if (ttftMs === null) ttftMs = performance.now() - t0;
          chunkCount += 1;
        }
      }
    }
    const totalMs = Math.round(performance.now() - t0);

    if (ttftMs === null) {
      return fail('no_content', '未收到任何输出内容（流为空）');
    }

    const hasUsage = usage && Number.isFinite(Number(usage.completion_tokens));
    const estimated = hasUsage ? 0 : 1;
    const completionTokens = hasUsage ? Number(usage.completion_tokens) : chunkCount;
    const ttft = Math.round(ttftMs);
    const genMs = Math.max(totalMs - ttft, 1);
    return ok({
      ttft_ms: ttft,
      total_ms: totalMs,
      completion_tokens: completionTokens,
      estimated,
      tps: round2(completionTokens / (genMs / 1000)),
      avg_tps: round2(completionTokens / (totalMs / 1000)),
      prompt_tokens: usage?.prompt_tokens ?? null,
    });
  } catch (err) {
    if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return fail('timeout', `请求超时（${timeoutMs}ms）`);
    }
    const cause = err?.cause?.code ?? err?.cause?.message;
    return fail('network', cause ? `${err?.message ?? err} (${cause})` : (err?.message ?? String(err)));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对一个模型执行一次探测。
 * @param model 模型记录（至少含 base_url/api_key/model/prompt/max_tokens/timeout_ms）
 * @param opts.persist 是否写入 probe_results
 */
export async function probeModel(model, { persist = true } = {}) {
  const result = await runProbe(model);
  if (persist && model.id != null) {
    const saved = insertProbeResult({ model_id: model.id, ...result });
    return { id: saved.id, model_id: model.id, created_at: saved.created_at, ...result };
  }
  return { model_id: model.id ?? null, created_at: new Date().toISOString(), ...result };
}
