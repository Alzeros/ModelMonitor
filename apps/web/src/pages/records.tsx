import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtDateTime, fmtMs, fmtTps, invalidTpsTitle } from '@/lib/format'
import {
  ERROR_TYPE_LABELS,
  RANGE_OPTIONS,
  modelName,
  type ModelRow,
  type ProbesResponse,
  type RangeKey,
} from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 20

type StatusFilter = 'all' | 'ok' | 'error'
type RangeFilter = 'all' | RangeKey
type QualityFilter = 'normal' | 'all' | 'invalid'

export function RecordsPage() {
  const [models, setModels] = useState<ModelRow[]>([])
  const [modelId, setModelId] = useState<string>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [range, setRange] = useState<RangeFilter>('all')
  const [quality, setQuality] = useState<QualityFilter>('normal')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<ProbesResponse>({ total: 0, items: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .listModels()
      .then(({ items }) => setModels(items))
      .catch((e) => toast.error(`模型列表加载失败：${(e as Error).message}`))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.listProbes({
        model_id: modelId === 'all' ? null : Number(modelId),
        status: status === 'all' ? '' : status,
        valid: quality === 'normal' ? 1 : quality === 'invalid' ? 0 : undefined,
        range: range === 'all' ? '' : range,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      setData(res)
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [modelId, status, range, quality, page])

  useEffect(() => {
    void load()
  }, [load])

  const modelMap = useMemo(() => new Map(models.map((m) => [m.id, m])), [models])
  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE))

  const changeFilter = (apply: () => void) => {
    apply()
    setPage(0)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">探测记录</h1>
        <p className="text-sm text-muted-foreground">所有探测的原始明细数据</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={modelId} onValueChange={(v) => changeFilter(() => setModelId(v))}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="全部模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模型</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.provider_name} / {modelName(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={status}
              onValueChange={(v) => changeFilter(() => setStatus(v as StatusFilter))}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="ok">成功</SelectItem>
                <SelectItem value="error">失败</SelectItem>
              </SelectContent>
            </Select>

            <Select value={range} onValueChange={(v) => changeFilter(() => setRange(v as RangeFilter))}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="全部时间" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部时间</SelectItem>
                {RANGE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={quality} onValueChange={(v) => changeFilter(() => setQuality(v as QualityFilter))}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="数据质量" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">仅正常</SelectItem>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="invalid">仅异常</SelectItem>
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="icon"
              className="ml-auto"
              onClick={() => void load()}
              aria-label="刷新"
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </div>
          <CardDescription>共 {data.total} 条记录</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>输出 T/s</TableHead>
                <TableHead className="hidden sm:table-cell">首字</TableHead>
                <TableHead className="hidden sm:table-cell">总耗时</TableHead>
                <TableHead className="hidden md:table-cell">可见 tok</TableHead>
                <TableHead className="hidden md:table-cell">思考 tok</TableHead>
                <TableHead className="hidden lg:table-cell">错误信息</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                    {loading ? '加载中…' : '暂无记录'}
                  </TableCell>
                </TableRow>
              ) : (
                data.items.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {fmtDateTime(p.created_at)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.model_id != null ? (
                        <>
                          <div className={modelMap.get(p.model_id)?.display_name ? '' : 'font-mono'}>
                            {modelMap.get(p.model_id)
                              ? modelName(modelMap.get(p.model_id)!)
                              : p.model_id}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {modelMap.get(p.model_id)?.display_name
                              ? `${modelMap.get(p.model_id)!.model} · `
                              : ''}
                            {modelMap.get(p.model_id)?.provider_name}
                          </div>
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      {p.status === 'ok' ? (
                        p.valid === 0 ? (
                          <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400" title={invalidTpsTitle(p.total_ms, p.ttft_ms)}>
                            异常
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-emerald-500/50 text-emerald-600 dark:text-emerald-400">
                            成功
                          </Badge>
                        )
                      ) : (
                        <Badge variant="destructive">
                          {ERROR_TYPE_LABELS[p.error_type ?? ''] ?? '失败'}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {p.status === 'ok' ? (
                        <span>
                          {fmtTps(p.tps)}
                          {p.estimated === 1 ? (
                            <span className="ml-1 text-xs text-muted-foreground" title="服务未返回 usage，按分块数估算">
                              ~
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden tabular-nums sm:table-cell">
                      {fmtMs(p.ttft_ms)}
                    </TableCell>
                    <TableCell className="hidden tabular-nums sm:table-cell">
                      {fmtMs(p.total_ms)}
                    </TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">
                      {p.content_tokens ?? '—'}
                    </TableCell>
                    <TableCell
                      className="hidden tabular-nums md:table-cell"
                      title={p.reasoning_tps != null ? `思考速度 ${fmtTps(p.reasoning_tps)} tok/s · ${fmtMs(p.reasoning_ms)}` : ''}
                    >
                      {p.reasoning_tokens ? p.reasoning_tokens : '—'}
                    </TableCell>
                    <TableCell
                      className="hidden max-w-[260px] truncate text-xs text-muted-foreground lg:table-cell"
                      title={p.error_message ?? ''}
                    >
                      {p.error_message ?? '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              第 {page + 1} / {totalPages} 页
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="icon"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                aria-label="上一页"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                aria-label="下一页"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
