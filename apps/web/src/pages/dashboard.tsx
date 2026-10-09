import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import {
  CartesianGrid,
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

        const map = new Map<string, Row>()
        probeRes.forEach((pr, i) => {
          const id = ids[i]
          for (const p of pr.items) {
            let row = map.get(p.created_at)
            if (!row) {
              row = { time: p.created_at }
              map.set(p.created_at, row)
            }
            if (p.tps != null) row[`tps_${id}`] = p.tps
            if (p.ttft_ms != null) row[`ttft_${id}`] = p.ttft_ms
          }
        })
        setRows([...map.values()].sort((a, b) => a.time.localeCompare(b.time)))
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
          toast.success(`探测成功：${fmtTps(r.tps)} tokens/s，首字 ${fmtMs(r.ttft_ms)}`)
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : models.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">还没有添加任何模型</p>
            <Button asChild>
              <Link to="/models">
                <Plus className="size-4" /> 去添加模型
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {models.map((m) => {
            const latest = m.latest ?? summaries[m.id]?.latest ?? null
            const stats = summaries[m.id]?.stats
            const isProbing = probing.has(m.id)
            return (
              <Card key={m.id} className={cn('gap-4', !m.enabled && 'opacity-60')}>
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
                    <CardTitle className="truncate text-base">{m.name}</CardTitle>
                    {!m.enabled ? (
                      <Badge variant="secondary" className="shrink-0">
                        <PauseCircle className="size-3" /> 已停用
                      </Badge>
                    ) : null}
                    <Badge variant="outline" className="ml-auto shrink-0 font-mono text-xs">
                      {m.model}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{m.base_url}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {latest ? (
                    latest.status === 'ok' ? (
                      <div>
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-3xl font-semibold tabular-nums">
                            {fmtTps(latest.tps)}
                          </span>
                          <span className="text-sm text-muted-foreground">tokens/s</span>
                          {latest.estimated === 1 ? (
                            <Badge variant="secondary" className="text-[10px]">
                              估算
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Timer className="size-3" />首字 {fmtMs(latest.ttft_ms)}
                          </span>
                          <span>总耗时 {fmtMs(latest.total_ms)}</span>
                          <span>输出 {latest.completion_tokens} tok</span>
                        </div>
                      </div>
                    ) : (
                      <div className="min-h-[52px] text-sm">
                        <span className="font-medium text-destructive">
                          {ERROR_TYPE_LABELS[latest.error_type ?? ''] ?? latest.error_type ?? '失败'}
                        </span>
                        <span className="ml-1 break-all text-muted-foreground" title={latest.error_message ?? ''}>
                          {latest.error_message}
                        </span>
                      </div>
                    )
                  ) : (
                    <div className="min-h-[52px] text-sm text-muted-foreground">暂无探测数据</div>
                  )}

                  <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {timeAgo(latest?.created_at)} · 每 {m.interval_minutes} 分钟
                      {stats && stats.total > 0
                        ? ` · ${range}成功率 ${stats.success_rate ?? 0}%`
                        : ''}
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
      )}

      {!loading && models.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">输出速度趋势（tokens/s）</CardTitle>
            </CardHeader>
            <CardContent>
              {hasOkData ? (
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
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(v) => fmtTimeTick(String(v), range)}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {models.map((m, i) => (
                      <Line
                        key={m.id}
                        type="monotone"
                        dataKey={`tps_${m.id}`}
                        name={m.name}
                        stroke={colorForIndex(i)}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">首字时间趋势（TTFT）</CardTitle>
            </CardHeader>
            <CardContent>
              {hasOkData ? (
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
                      tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}s` : `${v}ms`)}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(v) => fmtTimeTick(String(v), range)}
                      formatter={(value) => [fmtMs(Number(value)), undefined]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {models.map((m, i) => (
                      <Line
                        key={m.id}
                        type="monotone"
                        dataKey={`ttft_${m.id}`}
                        name={m.name}
                        stroke={colorForIndex(i)}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyChart />
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}

function EmptyChart() {
  return (
    <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
      暂无成功的探测数据，等待定时探测产生结果
    </div>
  )
}
