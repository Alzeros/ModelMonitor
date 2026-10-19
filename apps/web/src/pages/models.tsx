import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, ListPlus, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtMs, fmtTps, invalidTpsTitle, timeAgo } from '@/lib/format'
import {
  ERROR_TYPE_LABELS,
  modelName,
  type ModelRow,
  type ModelWithLatest,
  type Provider,
  type ProviderInput,
  type Settings,
} from '@/lib/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const DEFAULT_PROMPT = 'Say "hello" and nothing else.'

/** 与后端 buildChatUrl 保持一致：兼容直接粘贴完整接口地址 */
function buildChatUrl(base: string): string {
  const b = base.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '')
  return `${b}/chat/completions`
}

function numOr(v: string, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

interface ProviderFormState {
  name: string
  base_url: string
  api_key: string
  prompt: string
  max_tokens: string
  timeout_ms: string
  interval_minutes: string
  probe_gap_ms: string
  enabled: boolean
}

function emptyProviderForm(defaultInterval?: string): ProviderFormState {
  return {
    name: '',
    base_url: '',
    api_key: '',
    prompt: DEFAULT_PROMPT,
    max_tokens: '256',
    timeout_ms: '60000',
    interval_minutes: defaultInterval ?? '30',
    probe_gap_ms: '5000',
    enabled: true,
  }
}

function toProviderForm(p: Provider): ProviderFormState {
  return {
    name: p.name,
    base_url: p.base_url,
    api_key: p.api_key,
    prompt: p.prompt,
    max_tokens: String(p.max_tokens),
    timeout_ms: String(p.timeout_ms),
    interval_minutes: String(p.interval_minutes),
    probe_gap_ms: String(p.probe_gap_ms),
    enabled: p.enabled === 1,
  }
}

export function ModelsPage() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<ModelWithLatest[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)

  // 供应商新增/编辑对话框
  const [provOpen, setProvOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [pform, setPform] = useState<ProviderFormState>(emptyProviderForm())
  const [savingProvider, setSavingProvider] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; count?: number; message?: string } | null>(null)

  // 添加模型对话框
  const [addOpen, setAddOpen] = useState(false)
  const [addFor, setAddFor] = useState<Provider | null>(null)
  const [manualModel, setManualModel] = useState('')
  const [addDisplayName, setAddDisplayName] = useState('')
  const [remoteList, setRemoteList] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [addingModels, setAddingModels] = useState(false)
  const [addThinking, setAddThinking] = useState<'default' | 'low' | 'high' | 'max'>('default')

  // 探测与删除
  const [probingIds, setProbingIds] = useState<Set<number>>(new Set())
  const [deletingModel, setDeletingModel] = useState<ModelRow | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<Provider | null>(null)

  // 模型显示名称（改名）
  const [renameModel, setRenameModel] = useState<ModelRow | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [savingName, setSavingName] = useState(false)

  const load = useCallback(async () => {
    try {
      const [{ items: ps }, { items: ms }, s] = await Promise.all([
        api.listProviders(),
        api.listModels(),
        api.getSettings(),
      ])
      setProviders(ps)
      setModels(ms)
      setSettings(s)
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const setField = <K extends keyof ProviderFormState>(key: K, value: ProviderFormState[K]) => {
    setPform((prev) => ({ ...prev, [key]: value }))
  }

  // ---------- 供应商 ----------

  const openCreateProvider = () => {
    setEditingProvider(null)
    setPform(emptyProviderForm(settings?.default_interval_minutes))
    setTestResult(null)
    setProvOpen(true)
  }

  const openEditProvider = (p: Provider) => {
    setEditingProvider(p)
    setPform(toProviderForm(p))
    setTestResult(null)
    setProvOpen(true)
  }

  const buildProviderBody = (): ProviderInput | null => {
    if (!pform.name.trim()) {
      toast.error('请填写名称')
      return null
    }
    if (!/^https?:\/\//i.test(pform.base_url.trim())) {
      toast.error('Base URL 必须以 http(s):// 开头')
      return null
    }
    return {
      name: pform.name.trim(),
      base_url: pform.base_url.trim(),
      api_key: pform.api_key,
      prompt: pform.prompt.trim() || DEFAULT_PROMPT,
      max_tokens: numOr(pform.max_tokens, 256, 1, 65536),
      timeout_ms: numOr(pform.timeout_ms, 60000, 1000, 600000),
      interval_minutes: numOr(pform.interval_minutes, 30, 1, 10080),
      probe_gap_ms: numOr(pform.probe_gap_ms, 5000, 0, 60000),
      enabled: pform.enabled,
    }
  }

  const saveProvider = async () => {
    const body = buildProviderBody()
    if (!body) return
    setSavingProvider(true)
    try {
      if (editingProvider) {
        await api.updateProvider(editingProvider.id, body)
        toast.success('供应商已更新')
      } else {
        await api.createProvider(body)
        toast.success('供应商已添加')
      }
      setProvOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingProvider(false)
    }
  }

  const testProvider = async () => {
    if (!/^https?:\/\//i.test(pform.base_url.trim())) {
      toast.error('请先填写正确的 Base URL')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.listRemoteModels({ base_url: pform.base_url.trim(), api_key: pform.api_key })
      setTestResult({ ok: true, count: r.items.length })
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const toggleProviderEnabled = async (p: Provider, enabled: boolean) => {
    try {
      await api.updateProvider(p.id, { enabled })
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ---------- 添加模型 ----------

  const openAddModels = (p: Provider) => {
    setAddFor(p)
    setManualModel('')
    setAddDisplayName('')
    setRemoteList(null)
    setSelected(new Set())
    setListError(null)
    setAddThinking('default')
    setAddOpen(true)
  }

  const fetchRemoteList = async () => {
    if (!addFor) return
    setLoadingList(true)
    setListError(null)
    setRemoteList(null)
    try {
      const r = await api.listRemoteModels({ base_url: addFor.base_url, api_key: addFor.api_key })
      setRemoteList(r.items)
      if (!r.items.length) setListError('服务返回了空列表')
    } catch (e) {
      setListError((e as Error).message)
    } finally {
      setLoadingList(false)
    }
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pendingModels = [...new Set([...selected, manualModel.trim()].filter(Boolean))]

  const saveAddModels = async () => {
    if (!addFor || !pendingModels.length) return
    setAddingModels(true)
    try {
      const r = await api.addProviderModels(
        addFor.id,
        pendingModels,
        addThinking,
        pendingModels.length === 1 ? addDisplayName : undefined
      )
      toast.success(
        `已添加 ${r.added} 个模型${r.skipped.length ? `，跳过已存在：${r.skipped.join('、')}` : ''}`
      )
      setAddOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAddingModels(false)
    }
  }

  // ---------- 模型操作 ----------

  const probeOne = async (id: number, name: string) => {
    setProbingIds((prev) => new Set(prev).add(id))
    try {
      const r = await api.probeModel(id)
      if (r.status === 'ok') {
        toast.success(`${name}：${fmtTps(r.avg_tps)} tokens/s，首字 ${fmtMs(r.ttft_ms)}`)
      } else {
        toast.error(
          `探测失败（${ERROR_TYPE_LABELS[r.error_type ?? ''] ?? r.error_type}）：${r.error_message}`
        )
      }
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setProbingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const toggleModelEnabled = async (m: ModelWithLatest, enabled: boolean) => {
    try {
      await api.updateModel(m.id, { enabled })
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const setModelThinking = async (m: ModelWithLatest, thinking_strength: string) => {
    try {
      await api.updateModel(m.id, { thinking_strength })
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const confirmDeleteModel = async () => {
    if (!deletingModel) return
    try {
      await api.deleteModel(deletingModel.id)
      toast.success(`已删除模型「${modelName(deletingModel)}」`)
      setDeletingModel(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  // ---------- 模型显示名称 ----------

  const openRename = (m: ModelRow) => {
    setRenameModel(m)
    setRenameValue(m.display_name)
  }

  const saveRename = async () => {
    if (!renameModel) return
    const name = renameValue.trim()
    setSavingName(true)
    try {
      await api.updateModel(renameModel.id, { display_name: name })
      toast.success(name ? `显示名称已设为「${name}」` : '已恢复显示默认模型 ID')
      setRenameModel(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingName(false)
    }
  }

  const confirmDeleteProvider = async () => {
    if (!deletingProvider) return
    try {
      await api.deleteProvider(deletingProvider.id)
      toast.success(`已删除供应商「${deletingProvider.name}」及其模型与记录`)
      setDeletingProvider(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const modelCountOf = (p: Provider) => models.filter((m) => m.provider_id === p.id).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">模型管理</h1>
          <p className="text-sm text-muted-foreground">
            供应商（OpenAI 兼容接入点）→ 模型；探测参数跟随供应商，模型可批量添加
          </p>
        </div>
        <Button onClick={openCreateProvider}>
          <Plus className="size-4" /> 添加供应商
        </Button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
      ) : providers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">还没有添加任何供应商</p>
            <Button onClick={openCreateProvider}>
              <Plus className="size-4" /> 添加供应商
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {providers.map((p) => {
            const pModels = models.filter((m) => m.provider_id === p.id)
            return (
              <Card key={p.id} className={cn('gap-4', !p.enabled && 'opacity-60')}>
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    <Badge variant="outline" className="text-xs">
                      每 {p.interval_minutes} 分钟
                    </Badge>
                    <div className="ml-auto flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">启用</span>
                      <Switch
                        checked={p.enabled === 1}
                        onCheckedChange={(v) => void toggleProviderEnabled(p, v)}
                        aria-label={`启用 ${p.name}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        title="编辑供应商"
                        onClick={() => openEditProvider(p)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 text-destructive hover:text-destructive"
                        title="删除供应商"
                        onClick={() => setDeletingProvider(p)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">{p.base_url}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {pModels.length === 0 ? (
                    <p className="py-2 text-sm text-muted-foreground">
                      暂无模型，点击下方「添加模型」（支持从服务获取列表批量添加）
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>模型</TableHead>
                          <TableHead title="（思考 token + 可见 token）÷ 完整请求耗时">最新整体吞吐（含思考）</TableHead>
                          <TableHead className="hidden sm:table-cell">首字</TableHead>
                          <TableHead className="hidden md:table-cell">上次探测</TableHead>
                          <TableHead>启用</TableHead>
                          <TableHead>思考</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pModels.map((m) => (
                          <TableRow key={m.id}>
                            <TableCell className="max-w-[220px] text-sm">
                              <div className="flex items-center gap-1">
                                <span
                                  className={cn(
                                    'truncate',
                                    m.display_name ? '' : 'font-mono',
                                    m.enabled === 0 || m.provider_enabled === 0 ? 'text-muted-foreground' : ''
                                  )}
                                  title={m.display_name ? m.model : undefined}
                                >
                                  {modelName(m)}
                                </span>
                                {m.display_name ? (
                                  <span className="hidden shrink-0 font-mono text-xs text-muted-foreground lg:inline">
                                    {m.model}
                                  </span>
                                ) : null}
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                                  title="修改显示名称"
                                  onClick={() => openRename(m)}
                                >
                                  <Pencil className="size-3" />
                                </Button>
                              </div>
                            </TableCell>
                            <TableCell>
                              {m.latest?.status === 'ok' ? (
                                m.latest.valid === 0 ? (
                                  <Badge variant="outline" className="border-amber-500/50 text-amber-600 dark:text-amber-400" title={invalidTpsTitle()}>
                                    吞吐待复测
                                  </Badge>
                                ) : (
                                  <span className="font-medium tabular-nums">
                                    {fmtTps(m.latest.avg_tps)}
                                  </span>
                                )
                              ) : m.latest?.status === 'error' ? (
                                <Badge variant="destructive" title={m.latest.error_message ?? ''}>
                                  {ERROR_TYPE_LABELS[m.latest.error_type ?? ''] ?? '失败'}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden text-sm tabular-nums sm:table-cell">
                              {fmtMs(m.latest?.ttft_ms)}
                            </TableCell>
                            <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                              {timeAgo(m.latest?.created_at)}
                            </TableCell>
                            <TableCell>
                              <Switch
                                checked={m.enabled === 1}
                                onCheckedChange={(v) => void toggleModelEnabled(m, v)}
                                aria-label={`启用 ${modelName(m)}`}
                              />
                            </TableCell>
                            <TableCell>
                              <Select
                                value={m.thinking_strength}
                                onValueChange={(v) => void setModelThinking(m, v)}
                              >
                                <SelectTrigger className="h-8 w-[84px] text-xs" aria-label={`思考强度 ${modelName(m)}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="default">默认</SelectItem>
                                  <SelectItem value="low">low</SelectItem>
                                  <SelectItem value="high">high</SelectItem>
                                  <SelectItem value="max">max</SelectItem>
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-8"
                                  title="立即探测"
                                  disabled={probingIds.has(m.id)}
                                  onClick={() => void probeOne(m.id, modelName(m))}
                                >
                                  {probingIds.has(m.id) ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <Play className="size-4" />
                                  )}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="size-8 text-destructive hover:text-destructive"
                                  title="删除模型"
                                  onClick={() => setDeletingModel(m)}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => openAddModels(p)}>
                      <Plus className="size-4" /> 添加模型
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* 供应商新增/编辑对话框 */}
      <Dialog open={provOpen} onOpenChange={setProvOpen}>
        <DialogContent className="max-h-[90svh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProvider ? '编辑供应商' : '添加供应商'}</DialogTitle>
            <DialogDescription>
              填写 OpenAI 兼容接口信息，保存后在其下添加要监控的模型
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="p-name">名称 *</Label>
              <Input
                id="p-name"
                value={pform.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="如自建模型服务"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="p-url">Base URL *</Label>
              <Input
                id="p-url"
                value={pform.base_url}
                onChange={(e) => setField('base_url', e.target.value)}
                placeholder="https://api.example.com/v1"
              />
              <p className="text-xs break-all text-muted-foreground">
                实际请求{' '}
                <code className="font-mono">
                  {pform.base_url.trim()
                    ? buildChatUrl(pform.base_url)
                    : '{Base URL}/chat/completions'}
                </code>
                （直接粘贴完整接口地址也能自动识别）
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="p-key">API Key</Label>
              <Input
                id="p-key"
                type="password"
                value={pform.api_key}
                onChange={(e) => setField('api_key', e.target.value)}
                placeholder="本地服务可留空"
                autoComplete="off"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="p-prompt">测试 Prompt</Label>
              <Textarea
                id="p-prompt"
                rows={2}
                value={pform.prompt}
                onChange={(e) => setField('prompt', e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="grid gap-2">
                <Label htmlFor="p-max">max_tokens</Label>
                <Input
                  id="p-max"
                  type="number"
                  min={1}
                  value={pform.max_tokens}
                  onChange={(e) => setField('max_tokens', e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="p-timeout">超时 (ms)</Label>
                <Input
                  id="p-timeout"
                  type="number"
                  min={1000}
                  step={1000}
                  value={pform.timeout_ms}
                  onChange={(e) => setField('timeout_ms', e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="p-interval">间隔 (分钟)</Label>
                <Input
                  id="p-interval"
                  type="number"
                  min={1}
                  value={pform.interval_minutes}
                  onChange={(e) => setField('interval_minutes', e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="p-gap" title="同一供应商内相邻两次探测请求的间隔，0 表示不间隔">
                  模型间隔 (ms)
                </Label>
                <Input
                  id="p-gap"
                  type="number"
                  min={0}
                  step={500}
                  value={pform.probe_gap_ms}
                  onChange={(e) => setField('probe_gap_ms', e.target.value)}
                  title="同一供应商内相邻两次探测请求的间隔，0 表示不间隔"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              同一供应商下的多个模型按顺序串行探测，相邻请求间隔「模型间隔」，避免并发互相干扰
            </p>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="p-enabled">启用定时探测</Label>
                <p className="text-xs text-muted-foreground">
                  停用后该供应商下所有模型不再自动探测
                </p>
              </div>
              <Switch
                id="p-enabled"
                checked={pform.enabled}
                onCheckedChange={(v) => setField('enabled', v)}
              />
            </div>

            {testResult ? (
              testResult.ok ? (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
                  连接成功，共 {testResult.count ?? 0} 个可用模型
                </div>
              ) : (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  连接失败：{testResult.message}
                </div>
              )
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={testing} onClick={() => void testProvider()}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : null}
              测试连接
            </Button>
            <Button variant="ghost" onClick={() => setProvOpen(false)}>
              取消
            </Button>
            <Button disabled={savingProvider} onClick={() => void saveProvider()}>
              {savingProvider ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加模型对话框 */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>添加模型 — {addFor?.name}</DialogTitle>
            <DialogDescription>手动输入模型 ID，或获取服务列表多选批量添加</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="m-model">模型 ID</Label>
              <div className="flex gap-2">
                <Input
                  id="m-model"
                  value={manualModel}
                  onChange={(e) => setManualModel(e.target.value)}
                  placeholder="如 GLM-5.3-Flash"
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  disabled={loadingList}
                  onClick={() => void fetchRemoteList()}
                >
                  {loadingList ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ListPlus className="size-4" />
                  )}
                  获取列表
                </Button>
              </div>
              {listError ? (
                <p className="text-xs break-all text-destructive">{listError}</p>
              ) : null}
            </div>

            {remoteList && remoteList.length > 0 ? (
              <div className="grid gap-2">
                <Label>
                  可用模型（点击勾选，已选 {selected.size} 个）
                </Label>
                <div className="flex max-h-56 flex-wrap gap-1 overflow-y-auto rounded-md border p-2">
                  {remoteList.map((id) => {
                    const on = selected.has(id)
                    return (
                      <Button
                        key={id}
                        type="button"
                        size="sm"
                        variant={on ? 'default' : 'outline'}
                        className="h-7 font-mono text-xs"
                        onClick={() => toggleSelect(id)}
                      >
                        {on ? <Check className="mr-1 size-3" /> : null}
                        {id}
                      </Button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {pendingModels.length > 0 ? (
              <p className="text-xs break-all text-muted-foreground">
                保存时将添加 {pendingModels.length} 个：{pendingModels.join('、')}
              </p>
            ) : null}

            {pendingModels.length === 1 ? (
              <div className="grid gap-2">
                <Label htmlFor="m-display">显示名称（可选）</Label>
                <Input
                  id="m-display"
                  value={addDisplayName}
                  onChange={(e) => setAddDisplayName(e.target.value)}
                  placeholder={`留空则显示 ${pendingModels[0]}`}
                  maxLength={50}
                />
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label>思考强度（批量应用到本次添加的模型）</Label>
              <Select
                value={addThinking}
                onValueChange={(v) => setAddThinking(v as 'default' | 'low' | 'high' | 'max')}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">默认（不发送，用模型自身默认）</SelectItem>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                思考型模型建议选 low（测接近纯解码吞吐）；非思考模型选默认即可
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              disabled={addingModels || pendingModels.length === 0}
              onClick={() => void saveAddModels()}
            >
              {addingModels ? <Loader2 className="size-4 animate-spin" /> : null}
              保存{pendingModels.length > 0 ? `（${pendingModels.length} 个）` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 修改模型显示名称 */}
      <Dialog open={renameModel !== null} onOpenChange={(v) => !v && setRenameModel(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>显示名称</DialogTitle>
            <DialogDescription className="font-mono break-all">
              {renameModel?.model}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="m-rename">名称（留空恢复默认）</Label>
            <Input
              id="m-rename"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={renameModel?.model}
              maxLength={50}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !savingName) void saveRename()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameModel(null)}>
              取消
            </Button>
            <Button disabled={savingName} onClick={() => void saveRename()}>
              {savingName ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除模型确认 */}
      <AlertDialog open={deletingModel !== null} onOpenChange={(v) => !v && setDeletingModel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除模型？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deletingModel ? modelName(deletingModel) : ''}」及其全部探测记录，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void confirmDeleteModel()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 删除供应商确认 */}
      <AlertDialog
        open={deletingProvider !== null}
        onOpenChange={(v) => !v && setDeletingProvider(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除供应商？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deletingProvider?.name}」及其 {deletingProvider ? modelCountOf(deletingProvider) : 0}{' '}
              个模型与全部探测记录，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void confirmDeleteProvider()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
