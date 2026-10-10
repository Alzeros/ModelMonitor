import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ArrowRight,
  ChevronDown,
  CircleCheck,
  CircleX,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Timer,
} from 'lucide-react'
import { api } from '@/lib/api'
import { CHART_COLORS, colorForIndex, fmtMs, fmtTps, fmtTimeTick, invalidTpsTitle, timeAgo } from '@/lib/format'
import {
  ERROR_TYPE_LABELS,
  RANGE_MS,
  RANGE_OPTIONS,
  modelName,
  type ModelWithLatest,
  type ProbeResult,
  type RangeKey,
  type Summary,
} from '@/lib/types'
import {
  SECTION_STORAGE_KEY,
  depsSignature,
  loadHiddenSections,
  neededDeps,
  parseDeps,
  visibleSectionIds,
  type SectionId,
} from '@/lib/dashboard-sections'
import { SectionToggles } from '@/components/section-toggles'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

type Row = { time: string } & Record<string, number | string>

const TOOLTIP_STYLE = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
}

/** 区块依赖的数据还没拉回来时的占位，区别于「已加载但确实没数据」 */
function SectionSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn('rounded-xl', className)} />
}

/**
 * 区块门控。不开就整块不渲染 —— 不是 CSS 隐藏：隐藏会把图表挂在宽度为 0 的容器上。
 * ready=false 表示该区块依赖的数据源还没拉，此时用骨架占位。
 */
function SectionGate({
  on,
  ready = true,
  skeleton,
  children,
}: {
  on: boolean
  ready?: boolean
  skeleton?: ReactNode
  children: ReactNode
}) {
  if (!on) return null
  if (!ready) return <>{skeleton ?? <SectionSkeleton />}</>
  return <>{children}</>
}

/** 各时间范围的时间桶粒度（毫秒）：不同模型的探测时刻不同，聚合到同一时间轴折线才能对齐 */
const BUCKET_MS: Record<RangeKey, number> = {
  '30m': 2 * 60_000,
  '1h': 5 * 60_000,
  '8h': 20 * 60_000,
  '24h': 3_600_000,
}

const RANGE_STORAGE_KEY = 'dashboard.range'

/** 对比图隐藏的模型（未勾选）：存 id 列表，新增模型默认显示 */
const HIDDEN_STORAGE_KEY = 'dashboard.compare.hidden'

/** 收起的供应商分组：存 provider_id 列表，默认全部展开 */
const COLLAPSED_STORAGE_KEY = 'dashboard.groups.collapsed'

function loadCollapsedGroups(): Set<number> {
  return loadHiddenIds(COLLAPSED_STORAGE_KEY)
}

function loadRange(): RangeKey {
  try {
    const v = localStorage.getItem(RANGE_STORAGE_KEY)
    if (v && RANGE_OPTIONS.some((o) => o.value === v)) return v as RangeKey
  } catch {
    /* ignore */
  }
  return '24h'
}

function loadHiddenIds(storageKey: string): Set<number> {
  try {
    const raw = localStorage.getItem(storageKey)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    if (Array.isArray(arr)) return new Set(arr.filter((v) => typeof v === 'number' && Number.isFinite(v)))
  } catch {
    /* ignore */
  }
  return new Set()
}

function loadTrendRange(key: string): RangeKey {
  try {
    const v = localStorage.getItem(key)
    if (v && RANGE_OPTIONS.some((o) => o.value === v)) return v as RangeKey
  } catch {
    /* ignore */
  }
  return '24h'
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/**
 * 自管容器宽度：替代 recharts ResponsiveContainer（其在 React 19 下会在元素销毁后
 * 读取 getBoundingClientRect 导致 null 崩溃）。callback ref 在元素挂载时 attach、
 * 卸载时断开，读取 clientWidth / contentRect（都不调 getBoundingClientRect）。
 */
function useElementWidth() {
  const [width, setWidth] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const cleanup = useCallback(() => {
    roRef.current?.disconnect()
    roRef.current = null
  }, [])
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        cleanup()
        return
      }
      setWidth(el.clientWidth || 600)
      cleanup()
      const ro = new ResizeObserver((entries) => {
        const w = Math.round(entries[0]?.contentRect.width ?? 0)
        if (w > 0) setWidth(w)
      })
      ro.observe(el)
      roRef.current = ro
    },
    [cleanup]
  )
  return { ref, width }
}

type RawProbes = Record<number, ProbeResult[]>

/** 把探测记录按指标与时间桶聚合：同桶内取平均值，让多模型折线在时间轴上对齐 */
function buildTrendRows(probes: RawProbes, prefix: 'tps' | 'ttft', rk: RangeKey): Row[] {
  const bucketMs = BUCKET_MS[rk]
  const since = Date.now() - RANGE_MS[rk]
  type Acc = { t: number; sums: Record<string, { s: number; c: number }> }
  const acc = new Map<number, Acc>()
  for (const arr of Object.values(probes)) {
    for (const p of arr) {
      if (p.valid === 0) continue
      const v = prefix === 'tps' ? p.tps : p.ttft_ms
      if (v == null) continue
      const t0 = new Date(p.created_at).getTime()
      if (t0 < since) continue
      const t = Math.floor(t0 / bucketMs) * bucketMs
      let row = acc.get(t)
      if (!row) {
        row = { t, sums: {} }
        acc.set(t, row)
      }
      const k = `${prefix}_${p.model_id}`
      const s = row.sums[k] ?? { s: 0, c: 0 }
      s.s += v
      s.c += 1
      row.sums[k] = s
    }
  }
  return [...acc.values()]
    .sort((a, b) => a.t - b.t)
    .map((row) => {
      const out: Row = { time: new Date(row.t).toISOString() }
      for (const [k, v] of Object.entries(row.sums)) {
        out[k] = Math.round((v.s / v.c) * 100) / 100
      }
      return out
    })
}

/** 图表卡片里的模型选择 chips：色点颜色与折线/条形一致，点击切换是否参与图表 */
function ModelChips({
  models,
  hidden,
  onToggle,
}: {
  models: ModelWithLatest[]
  hidden: Set<number>
  onToggle: (id: number) => void
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {models.map((m, i) => {
        const on = !hidden.has(m.id)
        return (
          <Button
            key={m.id}
            type="button"
            size="sm"
            variant={on ? 'outline' : 'ghost'}
            className={cn('h-7 gap-1.5 px-2.5 text-xs', !on && 'text-muted-foreground/50')}
            title={on ? '点击从图表中移除' : '点击加入图表'}
            onClick={() => onToggle(m.id)}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: colorForIndex(i), opacity: on ? 1 : 0.35 }}
            />
            {modelName(m)}
          </Button>
        )
      })}
    </div>
  )
}

function makeToggle(
  setter: Dispatch<SetStateAction<Set<number>>>,
  storageKey: string
): (id: number) => void {
  return (id) => {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      persist(storageKey, [...next])
      return next
    })
  }
}

// ---------- 概览区：统计卡 / 模型状态分布 / 延迟概览 / 最近探测记录 ----------

/** 区间总耗时聚合：P50 / P95 / 平均（仅统计测量有效样本） */
function latencyAggregates(
  probes: RawProbes,
  rk: RangeKey
): { p50: number | null; p95: number | null; avg: number | null } {
  const since = Date.now() - RANGE_MS[rk]
  const vals: number[] = []
  for (const arr of Object.values(probes)) {
    for (const p of arr) {
      if (p.valid === 0 || p.total_ms == null) continue
      if (new Date(p.created_at).getTime() < since) continue
      vals.push(p.total_ms)
    }
  }
  if (!vals.length) return { p50: null, p95: null, avg: null }
  vals.sort((a, b) => a - b)
  const pick = (f: number): number =>
    vals[Math.min(vals.length - 1, Math.max(0, Math.ceil(f * vals.length) - 1))]
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
  }
}

/** 延迟概览折线数据：所有启用模型的总耗时按时间桶取平均，与趋势图同口径对齐 */
function buildLatencyRows(probes: RawProbes, rk: RangeKey): Row[] {
  const bucketMs = BUCKET_MS[rk]
  const since = Date.now() - RANGE_MS[rk]
  type Acc = { t: number; sum: number; c: number }
  const acc = new Map<number, Acc>()
  for (const arr of Object.values(probes)) {
    for (const p of arr) {
      if (p.valid === 0 || p.total_ms == null) continue
      const t0 = new Date(p.created_at).getTime()
      if (t0 < since) continue
      const t = Math.floor(t0 / bucketMs) * bucketMs
      const row = acc.get(t) ?? { t, sum: 0, c: 0 }
      row.sum += p.total_ms
      row.c += 1
      acc.set(t, row)
    }
  }
  return [...acc.values()]
    .sort((a, b) => a.t - b.t)
    .map((r) => ({ time: new Date(r.t).toISOString(), ms: Math.round(r.sum / r.c) }))
}

/** 顶部统计卡：总计 / 在线 / 离线（仅统计启用模型，口径与下方区块一致） */
function StatCards({ total, online, offline }: { total: number; online: number; offline: number }) {
  const items = [
    { label: '总计模型', value: total, icon: Layers, tone: 'text-primary', sub: '启用中的模型' },
    { label: '在线模型', value: online, icon: CircleCheck, tone: 'text-emerald-500', sub: '最近一次探测成功' },
    { label: '离线模型', value: offline, icon: CircleX, tone: 'text-red-500', sub: '探测失败或未探测' },
  ] as const
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {items.map((it) => (
        <Card key={it.label} className="py-4">
          <CardContent className="flex items-center gap-3 px-4">
            <span
              className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent/60', it.tone)}
            >
              <it.icon className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{it.label}</p>
              <p className="text-glow font-mono text-2xl font-semibold leading-tight tabular-nums">{it.value}</p>
              <p className="truncate text-[11px] text-muted-foreground/70">{it.sub}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

/** 模型状态分布 · 按供应商：每行一根在线/离线堆叠条（置顶概览） */
function StatusDistributionPanel({
  stats,
}: {
  stats: { id: number; name: string; total: number; ok: number; err: number; unknown: number }[]
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">模型状态分布</CardTitle>
          <p className="text-xs text-muted-foreground">按供应商统计启用中的模型</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-emerald-500" />
            在线
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-red-500" />
            离线
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-muted-foreground/40" />
            未探测
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {stats.map((s) => (
          <div key={s.id} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-sm" title={s.name}>
              {s.name}
            </span>
            <div className="flex h-2.5 min-w-0 flex-1 items-center overflow-hidden rounded-full bg-muted">
              {(['ok', 'err', 'unknown'] as const).map((k) => {
                const v = s[k]
                if (!v) return null
                return (
                  <span
                    key={k}
                    className={cn(
                      'h-full',
                      k === 'ok' && 'bg-emerald-500',
                      k === 'err' && 'bg-red-500',
                      k === 'unknown' && 'bg-muted-foreground/40'
                    )}
                    style={{ width: `${(v / s.total) * 100}%` }}
                    title={`${k === 'ok' ? '在线' : k === 'err' ? '离线' : '未探测'} ${v} 个`}
                  />
                )
              })}
            </div>
            <span className="w-40 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {s.total} 个模型 · 在线 {s.ok} · 离线 {s.err}
              {s.unknown > 0 ? ` · 未探测 ${s.unknown}` : ''}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/** 延迟概览：区间 P50 / P95 / 平均总耗时 + 平均总耗时趋势 */
function LatencyOverviewPanel({
  range,
  onRangeChange,
  stats,
  rows,
  wrap,
}: {
  range: RangeKey
  onRangeChange: (v: string) => void
  stats: { p50: number | null; p95: number | null; avg: number | null }
  rows: Row[]
  wrap: ReturnType<typeof useElementWidth>
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">延迟概览</CardTitle>
          <p className="text-xs text-muted-foreground">所有启用模型 · 总耗时统计与趋势</p>
        </div>
        <Select value={range} onValueChange={onRangeChange}>
          <SelectTrigger className="h-8 w-[104px]" aria-label="延迟概览时间范围">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <div className="mb-4 grid grid-cols-3 gap-3">
          {(['P50', 'P95', '平均'] as const).map((label, i) => {
            const v = [stats.p50, stats.p95, stats.avg][i]
            return (
              <div key={label} className="rounded-lg border bg-accent/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">{label} 总耗时</p>
                <p className="text-glow font-mono text-xl font-semibold tabular-nums">{fmtMs(v)}</p>
              </div>
            )
          })}
        </div>
        {rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">所选时间范围内暂无探测数据</p>
        ) : (
          <div ref={wrap.ref} style={{ height: 220 }}>
            {wrap.width > 0 ? (
              <AreaChart
                width={wrap.width}
                height={220}
                data={rows}
                margin={{ top: 4, right: 12, bottom: 0, left: -10 }}
              >
                <defs>
                  <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS[0]} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={CHART_COLORS[0]} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="time"
                  tickFormatter={(v: string) => fmtTimeTick(v, range)}
                  minTickGap={48}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                  width={48}
                  tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}s` : `${v}ms`)}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(v) => fmtTimeTick(String(v), range)}
                  formatter={(value) => [fmtMs(Number(value)), '平均总耗时']}
                />
                <Area
                  type="monotone"
                  dataKey="ms"
                  name="平均总耗时"
                  stroke={CHART_COLORS[0]}
                  strokeWidth={2}
                  fill="url(#latencyFill)"
                  dot={false}
                  connectNulls
                />
              </AreaChart>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 最近探测记录折叠状态：false=展开（默认），localStorage 持久化 */
const RECENT_COLLAPSED_KEY = 'dashboard.recent.collapsed'

function loadRecentCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(RECENT_COLLAPSED_KEY)
    return raw === 'true' || raw === '1'
  } catch {
    return false
  }
}

/** 最近探测记录：全局最新 12 条（成功/失败都算），可折叠，入口跳转探测记录页 */
function RecentRecordsPanel({
  items,
  modelById,
}: {
  items: ProbeResult[]
  modelById: Map<number, ModelWithLatest>
}) {
  const [collapsed, setCollapsed] = useState(loadRecentCollapsed)
  const toggle = (next: boolean) => {
    setCollapsed(next)
    persist(RECENT_COLLAPSED_KEY, next)
  }
  return (
    <Collapsible open={!collapsed} onOpenChange={(v) => toggle(!v)}>
      <Card className="gap-3 py-4">
        <div className="flex items-center gap-1 px-4">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/40"
              aria-expanded={!collapsed}
            >
              <ChevronDown
                className={cn('size-4 shrink-0 text-muted-foreground transition-transform', collapsed && '-rotate-90')}
              />
              <CardTitle className="text-base">最近探测记录</CardTitle>
              <span className="shrink-0 text-xs text-muted-foreground">最近 24 小时 · 最新 12 条</span>
            </button>
          </CollapsibleTrigger>
          <Button asChild variant="ghost" size="sm" className="shrink-0 text-muted-foreground">
            <Link to="/records">
              查看全部 <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
        <CollapsibleContent>
          <CardContent className="px-4">
            {items.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">暂无探测记录</p>
            ) : (
              <ul className="divide-y divide-border">
            {items.map((p) => {
              const m = p.model_id != null ? modelById.get(p.model_id) : undefined
              return (
                <li
                  key={p.id ?? `${p.model_id}_${p.created_at}`}
                  className="flex items-center gap-3 py-2.5"
                >
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      p.status === 'ok' ? 'dot-glow bg-emerald-500 text-emerald-500' : 'bg-red-500 text-red-500'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {m ? modelName(m) : `模型 #${p.model_id}`}
                      <span className="ml-2 text-xs text-muted-foreground">{m?.provider_name}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.status === 'ok'
                        ? `TPS ${fmtTps(p.tps)} · 首字 ${fmtMs(p.ttft_ms)} · 总耗时 ${fmtMs(p.total_ms)}`
                        : `失败：${ERROR_TYPE_LABELS[p.error_type ?? ''] ?? p.error_type ?? '未知'} · ${p.error_message ?? ''}`}
                    </p>
                  </div>
                  {p.status === 'ok' && p.valid === 0 ? (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-amber-500/50 text-amber-600 dark:text-amber-400"
                      title={invalidTpsTitle(p.total_ms, p.ttft_ms)}
                    >
                      测量异常
                    </Badge>
                  ) : null}
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {timeAgo(p.created_at)}
                  </span>
                </li>
              )
            })}
          </ul>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

export function DashboardPage() {
  const [range, setRange] = useState<RangeKey>(loadRange)
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(() => loadHiddenIds(HIDDEN_STORAGE_KEY))
  const [models, setModels] = useState<ModelWithLatest[]>([])
  const [summaries, setSummaries] = useState<Record<number, Summary | null>>({})
  // 探测记录（一次拉 24h 内全量，趋势图按各自范围过滤/分桶）
  const [rawProbes, setRawProbes] = useState<RawProbes>({})
  const [tpsRange, setTpsRange] = useState<RangeKey>(() => loadTrendRange('dashboard.trend.tps.range'))
  const [ttftRange, setTtftRange] = useState<RangeKey>(() => loadTrendRange('dashboard.trend.ttft.range'))
  const [latencyRange, setLatencyRange] = useState<RangeKey>(() => loadTrendRange('dashboard.latency.range'))
  const [tpsHidden, setTpsHidden] = useState<Set<number>>(() => loadHiddenIds('dashboard.trend.tps.hidden'))
  const [ttftHidden, setTtftHidden] = useState<Set<number>>(() => loadHiddenIds('dashboard.trend.ttft.hidden'))
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(loadCollapsedGroups)
  // 区块显示开关：存的是「被隐藏」的 id，新增区块默认可见
  const [hiddenSections, setHiddenSections] = useState<Set<SectionId>>(loadHiddenSections)
  // 依赖数据源的「已就绪」标记：区分「还没拉」与「拉到了但没数据」
  const [summariesReady, setSummariesReady] = useState(false)
  const [probesReady, setProbesReady] = useState(false)
  const [recentReady, setRecentReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [probing, setProbing] = useState<Set<number>>(new Set())
  const [recentProbes, setRecentProbes] = useState<ProbeResult[]>([])

  /** 可见区块集合：渲染门控与按需取数都读它 */
  const visibleSections = useMemo(() => visibleSectionIds(hiddenSections), [hiddenSections])
  /** 本次需要请求的数据源。以签名为依赖，切换 needs 为空的区块不会触发取数 */
  const depSig = useMemo(() => depsSignature(neededDeps(visibleSections)), [visibleSections])
  const needed = useMemo(() => parseDeps(depSig), [depSig])
  const show = useCallback((id: SectionId) => visibleSections.has(id), [visibleSections])
  /** 顶部时间范围的 range 只喂给 summaries；两者都不可见时它是没有作用的死控件 */
  const showRangeTabs = visibleSections.has('compare') || visibleSections.has('providers')

  const changeSections = useCallback((next: Set<SectionId>) => {
    setHiddenSections(next)
    persist(SECTION_STORAGE_KEY, [...next])
  }, [])

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true)
      const wantSummaries = needed.has('summaries')
      const wantProbes = needed.has('modelProbes')
      const wantRecent = needed.has('recentProbes')
      try {
        const { items } = await api.listModels()
        // 已停用的供应商整体不进入仪表盘（分组/对比/趋势/请求都基于此过滤）
        const active = items.filter((m) => m.provider_enabled === 1 && m.enabled === 1)
        setModels(active)
        const ids = active.map((m) => m.id)
        if (!ids.length) {
          setSummaries({})
          setRawProbes({})
          setRecentProbes([])
          setSummariesReady(true)
          setProbesReady(true)
          setRecentReady(true)
          return
        }
        // 只为「有可见区块需要」的数据源发请求：关掉的区块不产生任何网络开销
        const [sumRes, probeRes, recentRes] = await Promise.all([
          wantSummaries
            ? Promise.all(ids.map((id) => api.modelSummary(id, range).catch(() => null)))
            : Promise.resolve(null),
          wantProbes
            ? Promise.all(
                ids.map((id) =>
                  api
                    .listProbes({ model_id: id, range: '24h', status: 'ok', order: 'asc', limit: 1000 })
                    .catch(() => ({ total: 0, items: [] }))
                )
              )
            : Promise.resolve(null),
          wantRecent
            ? // 全局最近记录（成功/失败都算），最多取 40 条再裁剪到 12 条展示
              api
                .listProbes({ range: '24h', order: 'desc', limit: 40 })
                .catch(() => ({ total: 0, items: [] }))
            : Promise.resolve(null),
        ])

        if (sumRes) {
          const sm: Record<number, Summary | null> = {}
          sumRes.forEach((s, i) => {
            sm[ids[i]] = s
          })
          setSummaries(sm)
          setSummariesReady(true)
        }

        if (probeRes) {
          const raw: RawProbes = {}
          probeRes.forEach((pr, i) => {
            raw[ids[i]] = pr.items.filter((p) => p.valid === 1)
          })
          setRawProbes(raw)
          setProbesReady(true)
        }

        if (recentRes) {
          const idSet = new Set(ids)
          setRecentProbes(
            recentRes.items.filter((p) => p.model_id != null && idSet.has(p.model_id)).slice(0, 12)
          )
          setRecentReady(true)
        }
      } catch (e) {
        toast.error(`加载失败：${(e as Error).message}`)
      } finally {
        setRefreshing(false)
        setLoading(false)
      }
    },
    [range, needed]
  )

  // 首屏骨架只在首次加载出现：切换时间范围 / 开关区块时静默重取，不整页闪骨架
  useEffect(() => {
    void load(true)
  }, [load])

  useEffect(() => {
    const t = setInterval(() => void load(true), 30_000)
    return () => clearInterval(t)
  }, [load])

  const probeOne = useCallback(
    async (id: number) => {
      setProbing((prev) => new Set(prev).add(id))
      try {
        const r = await api.probeModel(id)
        if (r.status === 'ok') {
          toast.success(`探测成功：${fmtTps(r.tps)} tok/s，首字 ${fmtMs(r.ttft_ms)}`)
        } else {
          toast.error(
            `探测失败（${ERROR_TYPE_LABELS[r.error_type ?? ''] ?? r.error_type}）：${r.error_message}`
          )
        }
        await load(true)
      } catch (e) {
        toast.error((e as Error).message)
      } finally {
        setProbing((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [load]
  )

  /** 模型对比数据：勾选的模型按所选时间范围的平均输出速度，降序排列 */
  const compareData = useMemo(() => {
    const list: { name: string; tps: number; color: string }[] = []
    models.forEach((m, i) => {
      if (hiddenIds.has(m.id)) return
      const avg = summaries[m.id]?.stats.tps.avg
      if (avg != null) {
        list.push({ name: modelName(m), tps: avg, color: colorForIndex(i) })
      }
    })
    return list.sort((a, b) => b.tps - a.tps)
  }, [models, summaries, hiddenIds])

  const toggleCompare = makeToggle(setHiddenIds, HIDDEN_STORAGE_KEY)
  const toggleTpsHidden = makeToggle(setTpsHidden, 'dashboard.trend.tps.hidden')
  const toggleTtftHidden = makeToggle(setTtftHidden, 'dashboard.trend.ttft.hidden')

  const cmpWrap = useElementWidth()
  const tpsWrap = useElementWidth()
  const ttftWrap = useElementWidth()

  const changeTpsRange = (v: string) => {
    setTpsRange(v as RangeKey)
    try {
      localStorage.setItem('dashboard.trend.tps.range', v)
    } catch {
      /* ignore */
    }
  }

  const changeTtftRange = (v: string) => {
    setTtftRange(v as RangeKey)
    try {
      localStorage.setItem('dashboard.trend.ttft.range', v)
    } catch {
      /* ignore */
    }
  }

  const changeLatencyRange = (v: string) => {
    setLatencyRange(v as RangeKey)
    try {
      localStorage.setItem('dashboard.latency.range', v)
    } catch {
      /* ignore */
    }
  }

  /** 供应商分组（models 已按 provider/模型 id 排序，按序分组） */
  const providerGroups = useMemo(() => {
    const map = new Map<number, { id: number; name: string; enabled: number; items: ModelWithLatest[] }>()
    for (const m of models) {
      let g = map.get(m.provider_id)
      if (!g) {
        g = { id: m.provider_id, name: m.provider_name, enabled: m.provider_enabled, items: [] }
        map.set(m.provider_id, g)
      }
      g.items.push(m)
    }
    return [...map.values()]
  }, [models])

  const toggleGroup = (pid: number, open: boolean) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (open) next.delete(pid)
      else next.add(pid)
      persist(COLLAPSED_STORAGE_KEY, [...next])
      return next
    })
  }

  const modelById = useMemo(() => new Map(models.map((m) => [m.id, m])), [models])

  /** 统计卡口径：最近一次探测成功 = 在线，失败或尚未探测都计入离线（总数守恒） */
  const statCounts = useMemo(() => {
    let online = 0
    let offline = 0
    for (const m of models) {
      const latest = m.latest ?? summaries[m.id]?.latest ?? null
      if (latest?.status === 'ok') online += 1
      else offline += 1
    }
    return { total: models.length, online, offline }
  }, [models, summaries])

  /** 模型状态分布：沿用供应商分组的顺序，仅统计启用模型 */
  const providerStats = useMemo(
    () =>
      providerGroups.map((g) => {
        let ok = 0
        let err = 0
        let unknown = 0
        for (const m of g.items) {
          const latest = m.latest ?? summaries[m.id]?.latest ?? null
          if (latest?.status === 'ok') ok += 1
          else if (latest?.status === 'error') err += 1
          else unknown += 1
        }
        return { id: g.id, name: g.name, total: g.items.length, ok, err, unknown }
      }),
    [providerGroups, summaries]
  )

  /** 延迟概览：区间聚合 + 时间桶趋势 */
  const latencyStats = useMemo(() => latencyAggregates(rawProbes, latencyRange), [rawProbes, latencyRange])
  const latencyRows = useMemo(() => buildLatencyRows(rawProbes, latencyRange), [rawProbes, latencyRange])
  const latencyWrap = useElementWidth()

  const hasCompare = compareData.length > 0
  const tpsRows = useMemo(() => buildTrendRows(rawProbes, 'tps', tpsRange), [rawProbes, tpsRange])
  const ttftRows = useMemo(() => buildTrendRows(rawProbes, 'ttft', ttftRange), [rawProbes, ttftRange])

  const tpsVisible = show('trend-tps')
  const ttftVisible = show('trend-ttft')

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-tech-gradient text-xl font-bold tracking-tight">仪表盘</h1>
          <p className="text-sm text-muted-foreground">模型状态、延迟与趋势总览，每 30 秒自动刷新</p>
        </div>
        <div className="flex items-center gap-2">
          {showRangeTabs ? (
            <Tabs
              value={range}
              onValueChange={(v) => {
                setRange(v as RangeKey)
                try {
                  localStorage.setItem(RANGE_STORAGE_KEY, v)
                } catch {
                  /* ignore */
                }
              }}
            >
              <TabsList>
                {RANGE_OPTIONS.map((o) => (
                  <TabsTrigger key={o.value} value={o.value}>
                    {o.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}
          <SectionToggles hidden={hiddenSections} onChange={changeSections} />
          <Button variant="outline" size="icon" onClick={() => void load()} aria-label="刷新">
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-64 rounded-xl" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        </div>
      ) : models.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              暂无启用中的模型（可在「模型管理」页添加或启用）
            </p>
            <Button asChild>
              <Link to="/models">
                <Plus className="size-4" /> 去添加模型
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : visibleSections.size === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              所有区块已隐藏，可用「显示区块」按需开启。
            </p>
            <SectionToggles hidden={hiddenSections} onChange={changeSections} />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 概览区：统计卡 → 模型状态分布（置顶）→ 延迟概览 → 最近探测记录 */}
          <SectionGate on={show('stats')}>
            <StatCards total={statCounts.total} online={statCounts.online} offline={statCounts.offline} />
          </SectionGate>
          <SectionGate on={show('status')}>
            <StatusDistributionPanel stats={providerStats} />
          </SectionGate>
          <SectionGate
            on={show('latency')}
            ready={probesReady}
            skeleton={<SectionSkeleton className="h-72" />}
          >
            <LatencyOverviewPanel
              range={latencyRange}
              onRangeChange={changeLatencyRange}
              stats={latencyStats}
              rows={latencyRows}
              wrap={latencyWrap}
            />
          </SectionGate>
          <SectionGate
            on={show('recent')}
            ready={recentReady}
            skeleton={<SectionSkeleton className="h-40" />}
          >
            <RecentRecordsPanel items={recentProbes} modelById={modelById} />
          </SectionGate>

          {/* 模型对比：横向条形图，一眼看出谁快谁慢 */}
          <SectionGate
            on={show('compare')}
            ready={summariesReady}
            skeleton={<SectionSkeleton className="h-72" />}
          >
          <Card>
            <CardHeader>
              <CardTitle className="text-base">模型对比 · 平均输出速度（tok/s）</CardTitle>
            </CardHeader>
            <CardContent>
              <ModelChips models={models} hidden={hiddenIds} onToggle={toggleCompare} />
              {!hasCompare ? (
                <p className="mb-2 text-sm text-muted-foreground">
                  暂无有效样本，等待定时探测或手动探测
                </p>
              ) : null}
              <div ref={cmpWrap.ref} style={{ height: Math.max(200, compareData.length * 34 + 40) }}>
                {cmpWrap.width > 0 ? (
                <BarChart
                  width={cmpWrap.width}
                  height={Math.max(200, compareData.length * 34 + 40)}
                  data={compareData}
                  layout="vertical"
                  margin={{ top: 4, right: 56, bottom: 0, left: 4 }}
                >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis
                      type="number"
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={150}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number) => [`${fmtTps(v)} tok/s`, '平均输出速度']}
                      cursor={{ fill: 'hsl(var(--accent))', opacity: 0.35 }}
                    />
                    <Bar dataKey="tps" radius={[0, 4, 4, 0]} maxBarSize={22}>
                      {compareData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                      <LabelList
                        dataKey="tps"
                        position="right"
                        formatter={(v: number) => fmtTps(v)}
                        style={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      />
                    </Bar>
                  </BarChart>
                ) : null}
              </div>
            </CardContent>
          </Card>
          </SectionGate>

          {/* 卡片墙：按供应商分组，点击组头折叠/展开 */}
          <SectionGate on={show('providers')}>
          <div className="space-y-3">
            {providerGroups.map((g) => {
              const open = !collapsedGroups.has(g.id)
              const okCount = g.items.filter((m) => (m.latest ?? summaries[m.id]?.latest)?.status === 'ok').length
              const errCount = g.items.filter((m) => (m.latest ?? summaries[m.id]?.latest)?.status === 'error').length
              return (
                <Collapsible key={g.id} open={open} onOpenChange={(v) => toggleGroup(g.id, v)}>
                  <Card className="gap-3 py-4">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-4 py-1 text-left hover:bg-accent/40"
                        aria-expanded={open}
                      >
                        <ChevronDown
                          className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')}
                        />
                        <span className="truncate text-sm font-semibold">{g.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{g.items.length} 个模型</span>
                        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                          {okCount > 0 ? (
                            <span className="flex items-center gap-1">
                              <span className="dot-glow size-2 rounded-full bg-emerald-500 text-emerald-500" />
                              {okCount}
                            </span>
                          ) : null}
                          {errCount > 0 ? (
                            <span className="flex items-center gap-1">
                              <span className="dot-glow size-2 rounded-full bg-red-500 text-red-500" />
                              {errCount}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent className="grid gap-4 px-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {g.items.map((m) => {
              const latest = m.latest ?? summaries[m.id]?.latest ?? null
              const stats = summaries[m.id]?.stats
              const isProbing = probing.has(m.id)
              return (
                <Card key={m.id} className="gap-3">
                  <CardHeader className="pb-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'dot-glow size-2 shrink-0 rounded-full animate-status-breath',
                          latest?.status === 'ok' && 'bg-emerald-500 text-emerald-500',
                          latest?.status === 'error' && 'bg-red-500 text-red-500',
                          !latest && 'bg-muted-foreground/40 text-muted-foreground'
                        )}
                      />
                      <CardTitle
                        className={cn('truncate text-sm', m.display_name ? '' : 'font-mono')}
                        title={m.display_name ? m.model : undefined}
                      >
                        {modelName(m)}
                      </CardTitle>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{m.provider_name}</p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {latest ? (
                      latest.status === 'ok' ? (
                        <div>
                          <div className="flex items-baseline gap-1.5">
                            {latest.valid === 0 ? (
                              <Badge
                                variant="outline"
                                className="border-amber-500/50 text-amber-600 dark:text-amber-400"
                                title={invalidTpsTitle(latest.total_ms, latest.ttft_ms)}
                              >
                                测量异常
                              </Badge>
                            ) : (
                              <>
                                <span className="text-glow font-mono text-2xl font-semibold tabular-nums">
                                  {fmtTps(latest.tps)}
                                </span>
                                <span className="text-xs text-muted-foreground">输出 tok/s</span>
                                {latest.estimated === 1 ? (
                                  <Badge variant="secondary" className="text-[10px]">
                                    估算
                                  </Badge>
                                ) : null}
                              </>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Timer className="size-3" />首字 {fmtMs(latest.ttft_ms)}
                            </span>
                            <span>总耗时 {fmtMs(latest.total_ms)}</span>
                            <span>可见 {latest.content_tokens} tok</span>
                          </div>
                          {latest.reasoning_tokens && latest.reasoning_tokens > 0 ? (
                            <p
                              className="text-xs text-amber-600 dark:text-amber-400"
                              title="思考阶段：token 数 / 速度 / 耗时"
                            >
                              思考 {latest.reasoning_tokens} tok · {fmtTps(latest.reasoning_tps)} tok/s ·{' '}
                              {fmtMs(latest.reasoning_ms)}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <div className="min-h-[44px] text-sm">
                          <span className="font-medium text-destructive">
                            {ERROR_TYPE_LABELS[latest.error_type ?? ''] ?? latest.error_type ?? '失败'}
                          </span>
                          <span
                            className="ml-1 break-all text-muted-foreground"
                            title={latest.error_message ?? ''}
                          >
                            {latest.error_message}
                          </span>
                        </div>
                      )
                    ) : (
                      <div className="min-h-[44px] text-sm text-muted-foreground">暂无探测数据</div>
                    )}

                    <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                      <span className="truncate">
                        {timeAgo(latest?.created_at)} · 每 {m.interval_minutes} 分钟
                        {stats && stats.total > 0 ? ` · ${range}成功率 ${stats.success_rate ?? 0}%` : ''}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title="立即探测"
                        disabled={isProbing}
                        onClick={() => void probeOne(m.id)}
                      >
                        {isProbing ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Play className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )
            })}
          </div>
          </SectionGate>

          {/* 趋势图：两张各自可开关；只有都可见时才用双列，单张占满整行 */}
          {tpsVisible || ttftVisible ? (
            !probesReady ? (
              <SectionSkeleton className="h-80" />
            ) : (
            <div className={cn('grid gap-4', tpsVisible && ttftVisible && 'lg:grid-cols-2')}>
              {tpsVisible ? (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">输出速度趋势（tok/s）</CardTitle>
                  <Select value={tpsRange} onValueChange={changeTpsRange}>
                    <SelectTrigger className="h-8 w-[104px]" aria-label="输出速度趋势时间范围">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RANGE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardHeader>
                <CardContent>
                  <ModelChips models={models} hidden={tpsHidden} onToggle={toggleTpsHidden} />
                  {tpsRows.length === 0 ? (
                    <p className="mb-2 text-sm text-muted-foreground">
                      {models.some((m) => !tpsHidden.has(m.id))
                        ? '所选时间范围内暂无探测数据'
                        : '未选择要展示的模型，点击上方选项加入'}
                    </p>
                  ) : null}
                  <div ref={tpsWrap.ref} style={{ height: 280 }}>
                  {tpsWrap.width > 0 ? (
                  <LineChart
                    width={tpsWrap.width}
                    height={280}
                    data={tpsRows}
                    margin={{ top: 4, right: 12, bottom: 0, left: -10 }}
                  >
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis
                          dataKey="time"
                          tickFormatter={(v: string) => fmtTimeTick(v, tpsRange)}
                          minTickGap={48}
                          tick={{ fontSize: 11 }}
                          stroke="hsl(var(--muted-foreground))"
                        />
                        <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={48} />
                        <Tooltip
                          contentStyle={TOOLTIP_STYLE}
                          labelFormatter={(v) => fmtTimeTick(String(v), tpsRange)}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                        {models.map((m, i) =>
                          tpsHidden.has(m.id) ? null : (
                            <Line
                              key={m.id}
                              type="monotone"
                              dataKey={`tps_${m.id}`}
                              name={modelName(m)}
                              stroke={colorForIndex(i)}
                              strokeWidth={2}
                              dot={false}
                              connectNulls
                            />
                          )
                        )}
                      </LineChart>
                  ) : null}
                </div>
                </CardContent>
              </Card>
              ) : null}

              {ttftVisible ? (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-base">首字时间趋势（TTFT）</CardTitle>
                  <Select value={ttftRange} onValueChange={changeTtftRange}>
                    <SelectTrigger className="h-8 w-[104px]" aria-label="首字时间趋势时间范围">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RANGE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardHeader>
                <CardContent>
                  <ModelChips models={models} hidden={ttftHidden} onToggle={toggleTtftHidden} />
                  {ttftRows.length === 0 ? (
                    <p className="mb-2 text-sm text-muted-foreground">
                      {models.some((m) => !ttftHidden.has(m.id))
                        ? '所选时间范围内暂无探测数据'
                        : '未选择要展示的模型，点击上方选项加入'}
                    </p>
                  ) : null}
                  <div ref={ttftWrap.ref} style={{ height: 280 }}>
                  {ttftWrap.width > 0 ? (
                  <LineChart
                    width={ttftWrap.width}
                    height={280}
                    data={ttftRows}
                    margin={{ top: 4, right: 12, bottom: 0, left: -10 }}
                  >
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis
                          dataKey="time"
                          tickFormatter={(v: string) => fmtTimeTick(v, ttftRange)}
                          minTickGap={48}
                          tick={{ fontSize: 11 }}
                          stroke="hsl(var(--muted-foreground))"
                        />
                        <YAxis
                          tick={{ fontSize: 11 }}
                          stroke="hsl(var(--muted-foreground))"
                          width={48}
                          tickFormatter={(v: number) =>
                            v >= 1000 ? `${Math.round(v / 100) / 10}s` : `${v}ms`
                          }
                        />
                        <Tooltip
                          contentStyle={TOOLTIP_STYLE}
                          labelFormatter={(v) => fmtTimeTick(String(v), ttftRange)}
                          formatter={(value) => [fmtMs(Number(value)), undefined]}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                        {models.map((m, i) =>
                          ttftHidden.has(m.id) ? null : (
                            <Line
                              key={m.id}
                              type="monotone"
                              dataKey={`ttft_${m.id}`}
                              name={modelName(m)}
                              stroke={colorForIndex(i)}
                              strokeWidth={2}
                              dot={false}
                              connectNulls
                            />
                          )
                        )}
                      </LineChart>
                  ) : null}
                </div>
                </CardContent>
              </Card>
              ) : null}
            </div>
            )
          ) : null}
        </>
      )}
    </div>
  )
}
