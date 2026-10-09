import { DEFAULT_PROMPT, insertProbeResult } from './db.mjs';
import { randomBytes } from 'node:crypto';

/** 由 base_url 计算实际请求地址；兼容用户直接粘贴完整接口地址的情况 */
function buildChatUrl(base) {
  const b = String(base).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return `${b}/chat/completions`;
}

function messagesOf(model) {
  const prompt = model.prompt || DEFAULT_PROMPT;
  // 部分网关会按 prompt 缓存响应：固定 prompt 会命中缓存、整包瞬回，
  // 测到的是缓存吞吐而非模型速度（输出阶段短得可疑）。注入一次性校验码破坏命中，
  // 迫使网关每次都做真实推理。校验码行为对测速无影响。
  const nonce = randomBytes(4).toString('hex');
  return [
    {
      role: 'user',
      // 校验码放在开头：网关缓存多以 prompt 前缀为 key，尾码无法命中破坏
      content: `（防缓存校验码 ${nonce}，请忽略本行）\n${prompt}`,
    },
  ];
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

/** 错误结果（无有效计时/token 数据） */
function fail(type, message) {
  return {
    status: 'error',
    valid: 0,
    ttft_ms: null,
    total_ms: null,
    completion_tokens: null,
    estimated: 0,
    tps: null,
    avg_tps: null,
    reasoning_tokens: null,
    reasoning_ms: null,
    reasoning_tps: null,
    content_tokens: null,
    prompt_tokens: null,
    error_type: type,
    error_message: truncate(message),
  };
}

function thinkingOf(model) {
  const v = model.thinking_strength;
  return v && v !== 'default' ? String(v) : null;
}

async function doFetch(model, url, { maxTokens, useStreamOptions, thinking, signal }) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(model.api_key ? { Authorization: `Bearer ${model.api_key}` } : {}),
    },
    body: JSON.stringify({
      model: model.model,
      messages: messagesOf(model),
      max_tokens: maxTokens,
      stream: true,
      ...(useStreamOptions ? { stream_options: { include_usage: true } } : {}),
      ...(thinking ? { reasoning_effort: thinking } : {}),
    }),
    signal,
  });
}

async function runProbe(model) {
  const timeoutMs = Math.min(600000, Math.max(1000, Number(model.timeout_ms) || 60000));
  const maxTokens = Math.min(65536, Math.max(1, Math.round(Number(model.max_tokens) || 256)));
  const thinking = thinkingOf(model);
  const t0 = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    // 候选地址：用户填的 base_url 可能缺少 /v1，404/405 时自动补 /v1 重试
    const candidates = [buildChatUrl(model.base_url)];
    if (!candidates[0].includes('/v1/')) {
      candidates.push(candidates[0].replace('/chat/completions', '/v1/chat/completions'));
    }
    let lastUrl = candidates[0];
    let res = null;
    for (const url of candidates) {
      lastUrl = url;
      res = await doFetch(model, url, { maxTokens, useStreamOptions: true, thinking, signal: controller.signal });
      if (res.status === 404 || res.status === 405) continue;
      break;
    }
    // 部分兼容服务不认识 stream_options 或 reasoning_effort 会返回 400，去掉这些参数重试一次
    if (res.status === 400) {
      res = await doFetch(model, lastUrl, { maxTokens, useStreamOptions: false, thinking: null, signal: controller.signal });
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      return fail(
        classifyStatus(res.status),
        `HTTP ${res.status} ${res.statusText} @ ${lastUrl}${bodyText ? `: ${bodyText}` : ''}`
      );
    }
    if (!res.body) {
      return fail('no_response_body', '响应没有可读的流');
    }

    const decoder = new TextDecoder('utf-8');
    const reader = res.body.getReader();
    let buffer = '';
    let firstReasoningTs = null; // 第一个 reasoning_content 分块的绝对时刻
    let firstContentTs = null;   // 第一个可见 content 分块的绝对时刻（= TTFT）
    let reasoningChunks = 0;
    let contentChunks = 0;
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
        const delta = evt?.choices?.[0]?.delta;
        const content = delta?.content;
        const reasoning = delta?.reasoning_content;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          if (firstReasoningTs === null) firstReasoningTs = performance.now();
          reasoningChunks += 1;
        }
        if (typeof content === 'string' && content.length > 0) {
          if (firstContentTs === null) firstContentTs = performance.now();
          contentChunks += 1;
        }
      }
    }
    const tEnd = performance.now();
    const totalMs = Math.round(tEnd - t0);

    const hasUsage = usage && Number.isFinite(Number(usage.completion_tokens));
    const estimated = hasUsage ? 0 : 1;
    const completionTokens = hasUsage ? Number(usage.completion_tokens) : reasoningChunks + contentChunks;
    const detailReasoning = usage?.completion_tokens_details?.reasoning_tokens;
    const reasoningTokens = Number.isFinite(Number(detailReasoning))
      ? Number(detailReasoning)
      : (hasUsage ? 0 : reasoningChunks);
    const contentTokens = hasUsage ? Math.max(0, completionTokens - reasoningTokens) : contentChunks;

    const ttftMs = firstContentTs ? Math.round(firstContentTs - t0) : null;
    // 思考阶段：首个思考分块 → 首个可见输出（若无可见输出则到流结束）
    const reasoningDurMs = firstReasoningTs ? Math.round((firstContentTs || tEnd) - firstReasoningTs) : 0;
    // 输出阶段：首个可见输出 → 流结束
    const contentDurMs = firstContentTs ? Math.round(tEnd - firstContentTs) : 0;

    const outputTps = contentTokens > 0 && contentDurMs > 0 ? round2(contentTokens / (contentDurMs / 1000)) : null;
    const reasoningTps = reasoningTokens > 0 && reasoningDurMs > 0 ? round2(reasoningTokens / (reasoningDurMs / 1000)) : null;
    const avgTps = completionTokens > 0 ? round2(completionTokens / (totalMs / 1000)) : null;

    // 有效性判定：输出阶段过短(<100ms)或 tps 超出物理上限(>5000)视为异常——tps 置空、valid=0
    const isValid =
      firstContentTs !== null &&
      contentDurMs >= 100 &&
      outputTps != null &&
      Number.isFinite(outputTps) &&
      outputTps <= 5000;
    const valid = isValid ? 1 : 0;

    const base = {
      valid,
      ttft_ms: ttftMs,
      total_ms: totalMs,
      completion_tokens: completionTokens,
      estimated,
      reasoning_tokens: reasoningTokens,
      reasoning_ms: reasoningDurMs,
      reasoning_tps: reasoningTps,
      content_tokens: contentTokens,
      prompt_tokens: usage?.prompt_tokens ?? null,
    };

    if (firstContentTs === null) {
      // 无可见输出：可能是思考阶段耗尽 max_tokens
      const hasReasoning = reasoningTokens > 0;
      return {
        status: 'error',
        ...base,
        valid: 0,
        tps: null,
        avg_tps: avgTps,
        error_type: 'no_content',
        error_message: hasReasoning
          ? '思考阶段耗尽 max_tokens，未产生可见输出；可调大 max_tokens 或降低思考强度'
          : '未收到任何输出内容（流为空）',
      };
    }

    return { status: 'ok', ...base, tps: isValid ? outputTps : null, avg_tps: avgTps, error_type: null, error_message: null };
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
 * @param model 模型记录（含 base_url/api_key/model/prompt/max_tokens/timeout_ms/thinking_strength）
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
