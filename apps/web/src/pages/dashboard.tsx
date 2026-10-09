import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Loader2, PauseCircle, Play, Plus, RefreshCw, Timer } from 'lucide-react'
import { api } from '@/lib/api'
import { colorForIndex, fmtMs, fmtTps, fmtTimeTick, timeAgo } from '@/lib/format'
import {
  ERROR_TYPE_LABELS,
  RANGE_OPTIONS,
  type ModelWithLatest,
  type RangeKey,
  type Summary,
} from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
  '1h': 2 * 60_000,
  '6h': 10 * 60_000,
  '24h': 3_600_000,
  '7d': 6 * 3_600_000,
}

export function DashboardPage() {
  const [range, setRange] = useState<RangeKey>('24h')
  const [models, setModels] = useState<ModelWithLatest[]>([])
  const [summaries, setSummaries] = useState<Record<number, Summary | null>>({})
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [probing, setProbing] = useState<Set<number>>(new Set())

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true)
      try {
        const { items } = await api.listModels()
        setModels(items)
        const ids = items.map((m) => m.id)
        if (!ids.length) {
          setSummaries({})
          setRows([])
          return
        }
        const [sumRes, probeRes] = await Promise.all([
          Promise.all(ids.map((id) => api.modelSummary(id, range).catch(() => null))),
          Promise.all(
            ids.map((id) =>
              api
                .listProbes({ model_id: id, range, status: 'ok', order: 'asc', limit: 1000 })
                .catch(() => ({ total: 0, items: [] }))
            )
          ),
        ])
        const sm: Record<number, Summary | null> = {}
        sumRes.forEach((s, i) => {
          sm[ids[i]] = s
        })
        setSummaries(sm)

        // 按时间桶聚合：同桶内取各模型的平均值，让多模型的折线在时间轴上对齐
        const bucketMs = BUCKET_MS[range]
        type Acc = { t: number; sums: Record<string, { s: number; c: number }> }
        const acc = new Map<number, Acc>()
        probeRes.forEach((pr, i) => {
          const id = ids[i]
          for (const p of pr.items) {
            if (p.valid === 0) continue
            const t = Math.floor(new Date(p.created_at).getTime() / bucketMs) * bucketMs
            let row = acc.get(t)
            if (!row) {
              row = { t, sums: {} }
              acc.set(t, row)
            }
            const pairs = [
              [`tps_${id}`, p.tps],
              [`ttft_${id}`, p.ttft_ms],
            ] as const
            for (const [k, v] of pairs) {
              if (v == null) continue
              const s = row.sums[k] ?? { s: 0, c: 0 }
              s.s += v
              s.c += 1
              row.sums[k] = s
            }
          }
        })
        const nextRows: Row[] = [...acc.values()]
          .sort((a, b) => a.t - b.t)
          .map((row) => {
            const out: Row = { time: new Date(row.t).toISOString() }
            for (const [k, v] of Object.entries(row.sums)) {
              out[k] = Math.round((v.s / v.c) * 100) / 100
            }
            return out
          })
        setRows(nextRows)
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

  /** 模型对比数据：取各模型最近一次有效探测的输出速度，降序排列 */
  const compareData = useMemo(() => {
    const list: { name: string; tps: number; color: string }[] = []
    models.forEach((m, i) => {
      const l = m.latest
      if (l && l.status === 'ok' && l.valid === 1 && l.tps != null) {
        list.push({ name: m.model, tps: l.tps, color: colorForIndex(i) })
      }
    })
    return list.sort((a, b) => b.tps - a.tps)
  }, [models])

  const hasCompare = compareData.length > 0
  const hasOkData = rows.length > 0

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">仪表盘</h1>
          <p className="text-sm text-muted-foreground">模型输出效率总览，每 30 秒自动刷新</p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={range} onValueChange={(v) => setRange(v as RangeKey)}>
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
            <p className="text-sm text-muted-foreground">还没有添加供应商和模型</p>
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
              <CardTitle className="text-base">模型对比 · 最新输出速度（tok/s）</CardTitle>
            </CardHeader>
            <CardContent>
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
                      formatter={(v: number) => [`${fmtTps(v)} tok/s`, '输出速度']}
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
              ) : (
                <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
                  暂无有效的探测数据，等待定时探测或手动探测
                </div>
              )}
            </CardContent>
          </Card>

          {/* 卡片墙（紧凑） */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {models.map((m) => {
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
                      <CardTitle className="truncate font-mono text-sm">{m.model}</CardTitle>
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
          </div>

          {/* 趋势图 */}
          {hasOkData ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">输出速度趋势（tok/s）</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="time"
                        tickFormatter={(v: string) => fmtTimeTick(v, range)}
                        minTickGap={48}
                        tick={{ fontSize: 11 }}
                        stroke="hsl(var(--muted-foreground))"
                      />
                      <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={48} />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        labelFormatter={(v) => fmtTimeTick(String(v), range)}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                      {models.map((m, i) => (
                        <Line
                          key={m.id}
                          type="monotone"
                          dataKey={`tps_${m.id}`}
                          name={m.model}
                          stroke={colorForIndex(i)}
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">首字时间趋势（TTFT）</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: -10 }}>
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
                        tickFormatter={(v: number) =>
                          v >= 1000 ? `${Math.round(v / 100) / 10}s` : `${v}ms`
                        }
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        labelFormatter={(v) => fmtTimeTick(String(v), range)}
                        formatter={(value) => [fmtMs(Number(value)), undefined]}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} iconSize={10} />
                      {models.map((m, i) => (
                        <Line
                          key={m.id}
                          type="monotone"
                          dataKey={`ttft_${m.id}`}
                          name={m.model}
                          stroke={colorForIndex(i)}
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
