import { getModelConfig, listModelsView } from './db.mjs';
import { probeModel } from './prober.mjs';

/** model_id -> { startTimer, tickTimer } */
const timers = new Map();
/** 正在探测中的 model_id 集合，防止同一模型并发探测 */
const running = new Set();

const JITTER_MS = 30_000;

function clearTimers(entry) {
  if (!entry) return;
  if (entry.startTimer) clearTimeout(entry.startTimer);
  if (entry.tickTimer) clearInterval(entry.tickTimer);
}

/** 清空全部定时任务 */
export function stopScheduler() {
  for (const entry of timers.values()) clearTimers(entry);
  timers.clear();
}

/** 按当前 供应商+模型 配置重建全部定时探测任务（任何增删改后调用） */
export function reloadScheduler() {
  stopScheduler();
  for (const m of listModelsView()) {
    if (!m.enabled || !m.provider_enabled) continue;
    const id = m.id;
    const minutes = Math.min(10080, Math.max(1, Math.round(Number(m.interval_minutes) || 30)));
    // 启动时随机延迟错峰，避免同时打所有供应商
    const startTimer = setTimeout(() => {
      const tickTimer = setInterval(() => {
        void triggerProbe(id);
      }, minutes * 60_000);
      const entry = timers.get(id);
      if (entry) entry.tickTimer = tickTimer;
    }, Math.floor(Math.random() * JITTER_MS));
    timers.set(id, { startTimer, tickTimer: null });
  }
}

/**
 * 触发一次探测（带并发防重入）。仅在模型与供应商均启用时执行。
 * 手动探测请用 runManualProbe。
 */
export async function triggerProbe(id) {
  if (running.has(id)) return null;
  const cfg = getModelConfig(id);
  if (!cfg || !cfg.enabled || !cfg.provider_enabled) return null;
  running.add(id);
  try {
    return await probeModel(cfg);
  } finally {
    running.delete(id);
  }
}

/** 手动探测：绕过 enabled 限制，但同样防重入 */
export async function runManualProbe(id) {
  if (running.has(id)) return { error: 'probe_running' };
  const cfg = getModelConfig(id);
  if (!cfg) return { error: 'not_found' };
  running.add(id);
  try {
    return await probeModel(cfg);
  } finally {
    running.delete(id);
  }
}
