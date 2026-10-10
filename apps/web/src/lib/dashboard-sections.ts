/**
 * 仪表盘区块注册表 —— 唯一事实源。
 *
 * 这份清单被三处消费，任何一处都不要自己另写一份：
 *   1. 开关面板（components/section-toggles.tsx）渲染哪些行
 *   2. dashboard.tsx 的渲染门控（区块是否显示）
 *   3. dashboard.tsx 的按需取数（关闭的区块不产生任何请求）
 *
 * 新增区块只需在这里加一行，三处自动生效。
 */

export type SectionId =
  | 'stats'
  | 'status'
  | 'compare'
  | 'providers'
  | 'latency'
  | 'recent'
  | 'trend-tps'
  | 'trend-ttft'

/** 受门控的数据源：相关区块全部关闭时，对应请求不再发出 */
export type DataDep = 'summaries' | 'modelProbes' | 'recentProbes'

export type SectionGroup = '概览' | '趋势'

export interface SectionMeta {
  id: SectionId
  label: string
  /** 开关面板里的一句话说明 */
  hint: string
  group: SectionGroup
  /** 空数组 = 只用 listModels 返回的数据，不产生额外请求 */
  needs: readonly DataDep[]
}

export const DASHBOARD_SECTIONS: readonly SectionMeta[] = [
  { id: 'stats', label: '统计卡', hint: '总计 / 在线 / 离线模型数', group: '概览', needs: [] },
  { id: 'status', label: '模型状态分布', hint: '按供应商的在线 / 离线堆叠条', group: '概览', needs: [] },
  { id: 'compare', label: '模型对比', hint: '平均输出速度横向条形图', group: '概览', needs: ['summaries'] },
  { id: 'providers', label: '供应商卡片墙', hint: '按供应商分组的模型卡片', group: '概览', needs: ['summaries'] },
  { id: 'latency', label: '延迟概览', hint: 'P50 / P95 / 平均总耗时与趋势', group: '概览', needs: ['modelProbes'] },
  { id: 'recent', label: '最近探测记录', hint: '最近 24 小时最新 12 条', group: '概览', needs: ['recentProbes'] },
  { id: 'trend-tps', label: '输出速度趋势', hint: '各模型输出速度（tok/s）折线', group: '趋势', needs: ['modelProbes'] },
  { id: 'trend-ttft', label: '首字时间趋势', hint: '各模型首字时间（TTFT）折线', group: '趋势', needs: ['modelProbes'] },
]

export const SECTION_GROUP_ORDER: readonly SectionGroup[] = ['概览', '趋势']

/** 规范顺序，用于生成稳定的数据源签名 */
export const DATA_DEPS: readonly DataDep[] = ['summaries', 'modelProbes', 'recentProbes']

export const ALL_SECTION_IDS: readonly SectionId[] = DASHBOARD_SECTIONS.map((s) => s.id)

const SECTION_ID_SET = new Set<string>(ALL_SECTION_IDS)

export const SECTION_STORAGE_KEY = 'dashboard.sections.hidden'

/**
 * 读取隐藏集合。存的是「被隐藏」的 id（新增区块默认可见，与对比图 chips 的约定一致）。
 * 注册表里已不存在的 id 会被丢弃，所以删改区块或手改 localStorage 后状态依然自洽。
 */
export function loadHiddenSections(): Set<SectionId> {
  try {
    const raw = localStorage.getItem(SECTION_STORAGE_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    if (Array.isArray(arr)) {
      return new Set(
        arr.filter((v): v is SectionId => typeof v === 'string' && SECTION_ID_SET.has(v))
      )
    }
  } catch {
    /* ignore */
  }
  return new Set()
}

/** 隐藏集合 → 可见集合（按注册表顺序） */
export function visibleSectionIds(hidden: ReadonlySet<SectionId>): Set<SectionId> {
  const out = new Set<SectionId>()
  for (const id of ALL_SECTION_IDS) {
    if (!hidden.has(id)) out.add(id)
  }
  return out
}

/** 可见区块 → 本次需要请求的数据源 */
export function neededDeps(visible: ReadonlySet<SectionId>): Set<DataDep> {
  const out = new Set<DataDep>()
  for (const s of DASHBOARD_SECTIONS) {
    if (!visible.has(s.id)) continue
    for (const d of s.needs) out.add(d)
  }
  return out
}

/**
 * 数据源集合的稳定签名（按 DATA_DEPS 规范顺序）。
 * 用作 React 依赖：只有「真正需要的数据源」变了才重新取数 ——
 * 切换一个 needs 为空的区块（如统计卡）不该触发任何请求。
 */
export function depsSignature(deps: ReadonlySet<DataDep>): string {
  return DATA_DEPS.filter((d) => deps.has(d)).join(',')
}

/** 签名 → 数据源集合（签名稳定则返回的 Set 内容与顺序也稳定） */
export function parseDeps(sig: string): Set<DataDep> {
  if (!sig) return new Set<DataDep>()
  const parts = new Set(sig.split(','))
  return new Set(DATA_DEPS.filter((d) => parts.has(d)))
}
