import { getModelConfig, getProvider, listModelsView, listProviders } from './db.mjs';
import { probeModel } from './prober.mjs';

/** provider_id -> { timer }，定时粒度为供应商 */
const timers = new Map();
/** provider_id -> [{ modelId, resolve }]，供应商内串行探测队列 */
const queues = new Map();
/** 正在消化队列的 provider_id 集合 */
const draining = new Set();
/** 已在队列中的 model_id 集合，防止重复排队 */
const enqueued = new Set();
/** provider_id -> { at, intervalMs }：下一次计划触发时刻，配置变更重建定时器时保持节拍 */
const scheduledAt = new Map();

const JITTER_MS = 30_000;
/** 服务启动/新增供应商后，首轮探测的额外延迟（不必等一个完整周期才出数据） */
const FIRST_RUN_EXTRA_MS = 15_000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function gapOf(provider) {
  return Math.min(60000, Math.max(0, Math.round(Number(provider?.probe_gap_ms) || 0)));
}

/** 清空全部定时任务与队列（队列中等待的项以 null 完成）；保留节拍记录供重建 */
export function stopScheduler() {
  for (const entry of timers.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  timers.clear();
  for (const q of queues.values()) {
    for (const item of q) item.resolve(null);
  }
  queues.clear();
  draining.clear();
  enqueued.clear();
}

/** 供应商被删除时清理其节拍记录 */
export function forgetProvider(pid) {
  scheduledAt.delete(pid);
}

/**
 * 按供应商重建定时任务。到点后把该供应商下所有启用的模型按顺序入队，
 * 由串行队列逐个探测（同一供应商内绝不并发），不同供应商之间互不影响。
 *
 * 节拍规则：
 * - 首次启动/新增供应商/间隔变化：错峰后快速完成首轮，随后进入固定周期
 * - 其它配置变更重建定时器：保持原触发时刻；已到期未跑的尽快补上
 */
export function reloadScheduler() {
  stopScheduler();
  for (const p of listProviders()) {
    const pid = p.id;
    if (!p.enabled) {
      scheduledAt.delete(pid);
      continue;
    }
    const minutes = Math.min(10080, Math.max(1, Math.round(Number(p.interval_minutes) || 30)));
    const intervalMs = minutes * 60_000;

    let delay;
    const prev = scheduledAt.get(pid);
    if (!prev || prev.intervalMs !== intervalMs) {
      delay = Math.floor(Math.random() * JITTER_MS) + FIRST_RUN_EXTRA_MS;
    } else {
      delay = Math.max(5_000, Math.round(prev.at - Date.now()));
    }

    const fire = () => {
      scheduledAt.set(pid, { at: Date.now() + intervalMs, intervalMs });
      for (const m of listModelsView()) {
        if (m.provider_id === pid && m.enabled && m.provider_enabled) {
          enqueueProbe(pid, m.id, false);
        }
      }
      void drainProvider(pid);
    };

    timers.set(pid, { timer: setTimeout(fire, delay), intervalMs });
  }
}

/** 入队一个探测；manual=true 插队到最前。返回探测完成时 resolve 的 Promise（已在队列中则返回 null） */
function enqueueProbe(pid, modelId, manual) {
  if (enqueued.has(modelId)) return null;
  enqueued.add(modelId);
  return new Promise((resolve) => {
    let q = queues.get(pid);
    if (!q) {
      q = [];
      queues.set(pid, q);
    }
    const entry = { modelId, resolve, manual };
    if (manual) q.unshift(entry);
    else q.push(entry);
    void drainProvider(pid);
  });
}

/** 串行消化某供应商的探测队列，相邻两次探测之间保持 probe_gap_ms 间隔 */
async function drainProvider(pid) {
  if (draining.has(pid)) return;
  draining.add(pid);
  try {
    for (;;) {
      const q = queues.get(pid);
      if (!q || !q.length) break;
      const item = q.shift();
      enqueued.delete(item.modelId);
      const cfg = getModelConfig(item.modelId);
      // 模型已被删除，或定时探测但模型/供应商已停用 → 跳过（手动探测绕过启停限制）
      if (!cfg || (!item.manual && (!cfg.enabled || !cfg.provider_enabled))) {
        item.resolve(null);
        continue;
      }
      const result = await probeModel(cfg);
      item.resolve(result);
      const gap = gapOf(getProvider(pid));
      if (gap > 0 && queues.get(pid)?.length) await sleep(gap);
    }
  } finally {
    draining.delete(pid);
  }
}

/** 手动探测：插队到所属供应商队列最前，仍与该供应商其他探测严格串行 */
export async function runManualProbe(modelId) {
  const cfg = getModelConfig(modelId);
  if (!cfg) return { error: 'not_found' };
  const p = enqueueProbe(cfg.provider_id, modelId, true);
  if (!p) return { error: 'probe_running' };
  return p;
}
