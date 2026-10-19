import { format, differenceInSeconds } from 'date-fns'

export function fmtTps(tps: number | null | undefined): string {
  if (tps == null) return '—'
  return tps.toFixed(2)
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * 测量异常（valid=0）的悬停说明。
 *
 * 吞吐缺失或超过当前经验阈值时建议复测，不据此推断缓存命中或其他具体原因。
 * 可见输出窗口过短不再影响 valid —— 那种样本的吞吐是可信的，只是 `tps` 字段会为空。
 */
export function invalidTpsTitle(): string {
  return '整体吞吐数据缺失，或超过当前经验阈值（1000 tok/s）；暂不纳入统计，建议复测。该提示不代表已确认具体原因。'
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  return String(n)
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(new Date(iso), 'MM-dd HH:mm:ss')
}

export function fmtTimeTick(iso: string, range: string): string {
  const d = new Date(iso)
  if (range === '8h' || range === '24h') return format(d, 'MM-dd HH:mm')
  return format(d, 'HH:mm')
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '从未探测'
  const seconds = differenceInSeconds(new Date(), new Date(iso))
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

/**
 * 图表系列配色（分类色，按序分配、不循环生成）。
 * 该 8 色序列已通过配色校验：相邻对 CVD 色差 ΔE 8.4、常规视觉 ΔE 19.3，
 * 且在浅色（#ffffff）与深色（#15171c）表面上均满足 3:1 对比度。
 * 若启用第 9 个系列，应折叠为「其他」或改用分面小图，而非再生成一个色相。
 */
export const CHART_COLORS = [
  '#2a78d6', // 蓝
  '#eb6834', // 橙
  '#1baf7a', // 青
  '#eda100', // 黄
  '#e87ba4', // 品红
  '#008300', // 绿
  '#6250d6', // 紫
  '#e34948', // 红
]

export function colorForIndex(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]
}
