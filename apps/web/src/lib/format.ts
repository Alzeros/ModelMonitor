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

export const CHART_COLORS = ['#2563eb', '#16a34a', '#dc2626', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777']

export function colorForIndex(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]
}
