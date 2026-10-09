import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChevronDown, Loader2, PauseCircle, Play, Plus, RefreshCw, Timer } from 'lucide-react'
import { api } from '@/lib/api'
import { colorForIndex, fmtMs, fmtTps, fmtTimeTick, timeAgo } from '@/lib/format'
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

export function DashboardPage() {
  const [range, setRange] = useState<RangeKey>(loadRange)
  const [hiddenIds, setHiddenIds] = useState<Set<number>>(() => loadHiddenIds(HIDDEN_STORAGE_KEY))
  const [models, setModels] = useState<ModelWithLatest[]>([])
  const [summaries, setSummaries] = useState<Record<number, Summary | null>>({})
  // 探测记录（一次拉 24h 内全量，趋势图按各自范围过滤/分桶）
  const [rawProbes, setRawProbes] = useState<RawProbes>({})
  const [tpsRange, setTpsRange] = useState<RangeKey>(() => loadTrendRange('dashboard.trend.tps.range'))
  const [ttftRange, setTtftRange] = useState<RangeKey>(() => loadTrendRange('dashboard.trend.ttft.range'))
  const [tpsHidden, setTpsHidden] = useState<Set<number>>(() => loadHiddenIds('dashboard.trend.tps.hidden'))
  const [ttftHidden, setTtftHidden] = useState<Set<number>>(() => loadHiddenIds('dashboard.trend.ttft.hidden'))
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(loadCollapsedGroups)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [probing, setProbing] = useState<Set<number>>(new Set())

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true)
      try {
        const { items } = await api.listModels()
        // 已停用的供应商整体不进入仪表盘（分组/对比/趋势/请求都基于此过滤）
        const active = items.filter((m) => m.provider_enabled === 1)
        setModels(active)
        const ids = items.map((m) => m.id)
        if (!ids.length) {
          setSummaries({})
          setRawProbes({})
          return
        }
        const [sumRes, probeRes] = await Promise.all([
          Promise.all(ids.map((id) => api.modelSummary(id, range).catch(() => null))),
          Promise.all(
            ids.map((id) =>
              api
                .listProbes({ model_id: id, range: '24h', status: 'ok', order: 'asc', limit: 1000 })
                .catch(() => ({ total: 0, items: [] }))
            )
          ),
        ])
        const sm: Record<number, Summary | null> = {}
        sumRes.forEach((s, i) => {
          sm[ids[i]] = s
        })
        setSummaries(sm)

        const raw: RawProbes = {}
        probeRes.forEach((pr, i) => {
          raw[ids[i]] = pr.items.filter((p) => p.valid === 1)
        })
        setRawProbes(raw)
      } catch (e) {
        toast.error(`加载失败：${(e as Error).message}`)
      } finally {
        setRefreshing(false)
        setLoading(false)
      }
    },
    [range]
  )

  useEffect(() => {
    setLoading(true)
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

  const hasCompare = compareData.length > 0
  const hasOkData = useMemo(() => Object.values(rawProbes).some((arr) => arr.length > 0), [rawProbes])
  const tpsRows = useMemo(() => buildTrendRows(rawProbes, 'tps', tpsRange), [rawProbes, tpsRange])
  const ttftRows = useMemo(() => buildTrendRows(rawProbes, 'ttft', ttftRange), [rawProbes, ttftRange])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">仪表盘</h1>
          <p className="text-sm text-muted-foreground">模型输出效率总览，每 30 秒自动刷新</p>
        </div>
        <div className="flex items-center gap-2">
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
              暂无启用中的供应商和模型（可在「模型管理」页添加或启用）
            </p>
            <Button asChild>
              <Link to="/models">
                <Plus className="size-4" /> 去添加模型
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 模型对比：横向条形图，一眼看出谁快谁慢 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">模型对比 · 平均输出速度（tok/s）</CardTitle>
            </CardHeader>
            <CardContent>
              <ModelChips models={models} hidden={hiddenIds} onToggle={toggleCompare} />
              {hasCompare ? (
                <ResponsiveContainer width="100%" height={Math.max(200, compareData.length * 34 + 40)}>
                  <BarChart data={compareData} layout="vertical" margin={{ top: 4, right: 56, bottom: 0, left: 4 }}>
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
                </ResponsiveContainer>
              ) : models.some((m) => !hiddenIds.has(m.id)) ? (
                <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
                  暂无有效的探测数据，等待定时探测或手动探测
                </div>
              ) : (
                <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
                  未选择要对比的模型，点击上方选项加入
                </div>
              )}
            </CardContent>
          </Card>

          {/* 卡片墙：按供应商分组，点击组头折叠/展开 */}
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
                              <span className="size-2 rounded-full bg-emerald-500" />
                              {okCount}
                            </span>
                          ) : null}
                          {errCount > 0 ? (
                            <span className="flex items-center gap-1">
                              <span className="size-2 rounded-full bg-red-500" />
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
                <Card key={m.id} className={cn('gap-3', !m.enabled && 'opacity-60')}>
                  <CardHeader className="pb-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          latest?.status === 'ok' && 'bg-emerald-500',
                          latest?.status === 'error' && 'bg-red-500',
                          !latest && 'bg-muted-foreground/40'
                        )}
                      />
                      <CardTitle
                        className={cn('truncate text-sm', m.display_name ? '' : 'font-mono')}
                        title={m.display_name ? m.model : undefined}
                      >
                        {modelName(m)}
                      </CardTitle>
                      {!m.enabled || !m.provider_enabled ? (
                        <Badge variant="secondary" className="shrink-0">
                          <PauseCircle className="size-3" />
                          {!m.provider_enabled ? '供应商停用' : '已停用'}
                        </Badge>
                      ) : null}
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
                                title="测量异常（输出阶段过短或 tps 超限），已排除出统计"
                              >
                                测量异常
                              </Badge>
                            ) : (
                              <>
                                <span className="text-2xl font-semibold tabular-nums">
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

          {/* 趋势图 */}
          {hasOkData ? (
            <div className="grid gap-4 lg:grid-cols-2">
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
                  {tpsRows.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={tpsRows} margin={{ top: 4, right: 12, bottom: 0, left: -10 }}>
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
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                      {models.some((m) => !tpsHidden.has(m.id))
                        ? '所选时间范围内暂无探测数据'
                        : '未选择要展示的模型，点击上方选项加入'}
                    </div>
                  )}
                </CardContent>
              </Card>

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
                  {ttftRows.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={ttftRows} margin={{ top: 4, right: 12, bottom: 0, left: -10 }}>
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
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
                      {models.some((m) => !ttftHidden.has(m.id))
                        ? '所选时间范围内暂无探测数据'
                        : '未选择要展示的模型，点击上方选项加入'}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
