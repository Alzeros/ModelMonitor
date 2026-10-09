import { getModelConfig, getProvider, listModelsView, listProviders } from './db.mjs';
import { probeModel } from './prober.mjs';

/** provider_id -> { timer }，定时粒度为供应商；每轮 tick 后自链排下一轮 */
const timers = new Map();
/** provider_id -> [{ modelId, resolve }]，供应商内串行探测队列 */
const queues = new Map();
/** provider_id -> 当前允许消费队列的代数；新 tick 递增以作废仍在执行的老 drain */
const generation = new Map();
/** provider_id -> 正在执行的 drain 代数（同一代只允许一个 drain） */
const drainGen = new Map();
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
  enqueued.clear();
  // 正在执行的 probe 无法中断，跑完后由代数守卫自然退出，不影响新周期
}

/** 供应商被删除时清理其节拍记录与执行代 */
export function forgetProvider(pid) {
  scheduledAt.delete(pid);
  generation.delete(pid);
}

function gapDelay(pid, intervalMs) {
  const prev = scheduledAt.get(pid);
  if (!prev || prev.intervalMs !== intervalMs) {
    // 新供应商/首次启动/间隔变化：错峰后快速完成首轮，随后进入固定周期
    return Math.floor(Math.random() * JITTER_MS) + FIRST_RUN_EXTRA_MS;
  }
  // 其它配置变更重建定时器：保持原触发时刻；已到期未跑的尽快补上
  return Math.max(5_000, Math.round(prev.at - Date.now()));
}

function scheduleProvider(pid, intervalMs, delay) {
  timers.set(pid, {
    timer: setTimeout(() => tickProvider(pid, intervalMs), delay),
  });
}

/**
 * 按供应商重建定时任务。到点后把该供应商下所有启用的模型按顺序入队，
 * 由串行队列逐个探测（同一供应商内同一代绝不并发），不同供应商之间互不影响。
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
      generation.delete(pid);
      continue;
    }
    const minutes = Math.min(10080, Math.max(1, Math.round(Number(p.interval_minutes) || 30)));
    const intervalMs = minutes * 60_000;
    scheduleProvider(pid, intervalMs, gapDelay(pid, intervalMs));
  }
}

/** 单轮 tick：作废旧 drain → 入队全部启用模型 → 消化 → 排定下一轮 */
function tickProvider(pid, intervalMs) {
  const myGen = (generation.get(pid) ?? 0) + 1;
  generation.set(pid, myGen);
  scheduledAt.set(pid, { at: Date.now() + intervalMs, intervalMs });

  for (const m of listModelsView()) {
    if (m.provider_id === pid && m.enabled && m.provider_enabled) {
      enqueueProbe(pid, m.id, false);
    }
  }
  void drainProvider(pid, myGen);
  // 链式排定下一轮（fire 不依赖外部 reload 才会持久循环）
  scheduleProvider(pid, intervalMs, intervalMs);
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
  });
}

/**
 * 串行消化某供应商的探测队列，相邻两次探测之间保持 probe_gap_ms 间隔。
 * 同一代只允许一个 drain；代数失配（新 tick 已接管或供应商失效）时快速丢弃剩余并退出。
 * 新旧两代短暂并存时并发消费同一队列是安全的：每个 item 只会被 shift 一次。
 */
async function drainProvider(pid, myGen) {
  const existing = drainGen.get(pid);
  if (existing === myGen) return; // 同代 drain 已在跑，交给它消化
  drainGen.set(pid, myGen);
  try {
    for (;;) {
      if (generation.get(pid) !== myGen) {
        // 代已作废：本代未消费的项快速放行，避免等待方悬挂
        for (const item of queues.get(pid) ?? []) item.resolve(null);
        queues.set(pid, []);
        break;
      }
      const q = queues.get(pid);
      if (!q || !q.length) break;
      const item = q.shift();
      enqueued.delete(item.modelId);
      const cfg = getModelConfig(item.modelId);
      // 模型已被删除，或定时探测但模型/供应商已停用 → 跳过（手动探测绕过启停限制）
      if (!cfg || (!item.manual && (!cfg.enabled || !cfg.provider_enabled))) {
        item.resolve(null);
      } else {
        const result = await probeModel(cfg);
        item.resolve(result);
      }
      const gap = gapOf(getProvider(pid));
      if (gap > 0) await sleep(gap);
    }
  } finally {
    if (drainGen.get(pid) === myGen) drainGen.delete(pid);
  }
}

/** 手动探测：插队到所属供应商队列最前，仍与该供应商其他探测严格串行 */
export async function runManualProbe(modelId) {
  const cfg = getModelConfig(modelId);
  if (!cfg) return { error: 'not_found' };
  const p = enqueueProbe(cfg.provider_id, modelId, true);
  if (p) void drainProvider(cfg.provider_id, generation.get(cfg.provider_id) ?? 0);
  else return { error: 'probe_running' };
  return p;
}