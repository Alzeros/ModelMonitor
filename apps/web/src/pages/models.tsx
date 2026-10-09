import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ListPlus, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtMs, fmtTps, timeAgo } from '@/lib/format'
import {
  ERROR_TYPE_LABELS,
  type Model,
  type ModelInput,
  type ModelWithLatest,
  type ProbeResult,
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
  CardDescription,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

const DEFAULT_PROMPT = 'Say "hello" and nothing else.'

/** 与后端 buildChatUrl 保持一致：兼容直接粘贴完整接口地址 */
function buildChatUrl(base: string): string {
  const b = base.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '')
  return `${b}/chat/completions`
}

interface FormState {
  name: string
  base_url: string
  api_key: string
  model: string
  prompt: string
  max_tokens: string
  timeout_ms: string
  interval_minutes: string
  enabled: boolean
}

function emptyForm(defaultInterval?: string): FormState {
  return {
    name: '',
    base_url: '',
    api_key: '',
    model: '',
    prompt: DEFAULT_PROMPT,
    max_tokens: '256',
    timeout_ms: '60000',
    interval_minutes: defaultInterval ?? '30',
    enabled: true,
  }
}

function toForm(m: Model): FormState {
  return {
    name: m.name,
    base_url: m.base_url,
    api_key: m.api_key,
    model: m.model,
    prompt: m.prompt,
    max_tokens: String(m.max_tokens),
    timeout_ms: String(m.timeout_ms),
    interval_minutes: String(m.interval_minutes),
    enabled: m.enabled === 1,
  }
}

export function ModelsPage() {
  const [models, setModels] = useState<ModelWithLatest[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Model | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProbeResult | null>(null)
  const [probingIds, setProbingIds] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState<Model | null>(null)
  const [modelList, setModelList] = useState<string[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelListError, setModelListError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [{ items }, s] = await Promise.all([api.listModels(), api.getSettings()])
      setModels(items)
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

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm(settings?.default_interval_minutes))
    setTestResult(null)
    setModelList(null)
    setModelListError(null)
    setOpen(true)
  }

  const openEdit = (m: Model) => {
    setEditing(m)
    setForm(toForm(m))
    setTestResult(null)
    setModelList(null)
    setModelListError(null)
    setOpen(true)
  }

  const fetchModelList = async () => {
    if (!/^https?:\/\//i.test(form.base_url.trim())) {
      toast.error('请先填写正确的 Base URL')
      return
    }
    setLoadingModels(true)
    setModelListError(null)
    setModelList(null)
    try {
      const r = await api.listRemoteModels({ base_url: form.base_url.trim(), api_key: form.api_key })
      setModelList(r.items)
      if (!r.items.length) setModelListError('服务返回了空列表')
    } catch (e) {
      setModelListError((e as Error).message)
    } finally {
      setLoadingModels(false)
    }
  }

  const buildBody = (): ModelInput | null => {
    if (!form.name.trim()) {
      toast.error('请填写名称')
      return null
    }
    if (!/^https?:\/\//i.test(form.base_url.trim())) {
      toast.error('Base URL 必须以 http(s):// 开头')
      return null
    }
    if (!form.model.trim()) {
      toast.error('请填写模型 ID')
      return null
    }
    return {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      api_key: form.api_key,
      model: form.model.trim(),
      prompt: form.prompt.trim() || DEFAULT_PROMPT,
      max_tokens: Math.max(1, Number(form.max_tokens) || 256),
      timeout_ms: Math.min(600000, Math.max(1000, Number(form.timeout_ms) || 60000)),
      interval_minutes: Math.min(10080, Math.max(1, Number(form.interval_minutes) || 30)),
      enabled: form.enabled,
    }
  }

  const save = async () => {
    const body = buildBody()
    if (!body) return
    setSaving(true)
    try {
      if (editing) {
        await api.updateModel(editing.id, body)
        toast.success('模型已更新')
      } else {
        await api.createModel(body)
        toast.success('模型已添加')
      }
      setOpen(false)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async () => {
    if (!/^https?:\/\//i.test(form.base_url.trim())) {
      toast.error('Base URL 必须以 http(s):// 开头')
      return
    }
    if (!form.model.trim()) {
      toast.error('请填写模型 ID')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.probeTest({
        base_url: form.base_url.trim(),
        api_key: form.api_key,
        model: form.model.trim(),
        prompt: form.prompt.trim() || undefined,
        max_tokens: Math.max(1, Number(form.max_tokens) || 64),
        timeout_ms: Math.min(600000, Math.max(1000, Number(form.timeout_ms) || 30000)),
      })
      setTestResult(r)
    } catch (e) {
      setTestResult({
        model_id: null,
        status: 'error',
        ttft_ms: null,
        total_ms: null,
        completion_tokens: null,
        estimated: 0,
        tps: null,
        avg_tps: null,
        prompt_tokens: null,
        error_type: 'request',
        error_message: (e as Error).message,
        created_at: new Date().toISOString(),
      })
    } finally {
      setTesting(false)
    }
  }

  const probeOne = async (id: number) => {
    setProbingIds((prev) => new Set(prev).add(id))
    try {
      const r = await api.probeModel(id)
      if (r.status === 'ok') {
        toast.success(`${models.find((m) => m.id === id)?.name ?? ''}：${fmtTps(r.tps)} tokens/s，首字 ${fmtMs(r.ttft_ms)}`)
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

  const toggleEnabled = async (m: ModelWithLatest, enabled: boolean) => {
    try {
      await api.updateModel(m.id, { enabled })
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await api.deleteModel(deleting.id)
      toast.success(`已删除「${deleting.name}」`)
      setDeleting(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">模型管理</h1>
          <p className="text-sm text-muted-foreground">
            添加 OpenAI 兼容接入点（/v1/chat/completions），平台将按间隔定时探测
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="size-4" /> 添加模型
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">已接入模型</CardTitle>
          <CardDescription>共 {models.length} 个</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">加载中…</div>
          ) : models.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              暂无模型，点击右上角「添加模型」开始
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead className="hidden md:table-cell">Base URL</TableHead>
                  <TableHead>间隔</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead>最新 TPS</TableHead>
                  <TableHead className="hidden sm:table-cell">首字</TableHead>
                  <TableHead className="hidden lg:table-cell">上次探测</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <div className="font-medium">{m.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{m.model}</div>
                    </TableCell>
                    <TableCell className="hidden max-w-[240px] truncate font-mono text-xs text-muted-foreground md:table-cell">
                      {m.base_url}
                    </TableCell>
                    <TableCell className="text-sm">{m.interval_minutes} 分</TableCell>
                    <TableCell>
                      <Switch
                        checked={m.enabled === 1}
                        onCheckedChange={(v) => void toggleEnabled(m, v)}
                        aria-label={`启用 ${m.name}`}
                      />
                    </TableCell>
                    <TableCell>
                      {m.latest?.status === 'ok' ? (
                        <span className="font-medium tabular-nums">{fmtTps(m.latest.tps)}</span>
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
                    <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                      {timeAgo(m.latest?.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8"
                          title="立即探测"
                          disabled={probingIds.has(m.id)}
                          onClick={() => void probeOne(m.id)}
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
                          className="size-8"
                          title="编辑"
                          onClick={() => openEdit(m)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 text-destructive hover:text-destructive"
                          title="删除"
                          onClick={() => setDeleting(m)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 新增 / 编辑对话框 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑模型' : '添加模型'}</DialogTitle>
            <DialogDescription>
              填写 OpenAI 兼容接口信息，保存后按间隔自动探测
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="f-name">名称 *</Label>
                <Input
                  id="f-name"
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                  placeholder="如 DeepSeek 官方"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="f-model">模型 ID *</Label>
                <div className="flex gap-2">
                  <Input
                    id="f-model"
                    value={form.model}
                    onChange={(e) => setField('model', e.target.value)}
                    placeholder="如 deepseek-chat"
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    disabled={loadingModels || !form.base_url.trim()}
                    title={form.base_url.trim() ? '从该服务获取可用模型列表' : '请先填写 Base URL'}
                    onClick={() => void fetchModelList()}
                  >
                    {loadingModels ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ListPlus className="size-4" />
                    )}
                    获取列表
                  </Button>
                </div>
                {modelListError ? (
                  <p className="text-xs break-all text-destructive">{modelListError}</p>
                ) : null}
                {modelList && modelList.length > 0 ? (
                  <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded-md border p-2">
                    {modelList.map((id) => (
                      <Button
                        key={id}
                        type="button"
                        size="sm"
                        variant={form.model === id ? 'default' : 'outline'}
                        className="h-7 font-mono text-xs"
                        onClick={() => setField('model', id)}
                      >
                        {id}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="f-url">Base URL *</Label>
              <Input
                id="f-url"
                value={form.base_url}
                onChange={(e) => setField('base_url', e.target.value)}
                placeholder="https://api.example.com/v1"
              />
              <p className="text-xs break-all text-muted-foreground">
                实际请求{' '}
                <code className="font-mono">
                  {form.base_url.trim()
                    ? buildChatUrl(form.base_url)
                    : '{Base URL}/chat/completions'}
                </code>
                （直接粘贴完整接口地址也能自动识别）
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="f-key">API Key</Label>
              <Input
                id="f-key"
                type="password"
                value={form.api_key}
                onChange={(e) => setField('api_key', e.target.value)}
                placeholder="本地服务可留空"
                autoComplete="off"
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="f-prompt">测试 Prompt</Label>
              <Textarea
                id="f-prompt"
                rows={2}
                value={form.prompt}
                onChange={(e) => setField('prompt', e.target.value)}
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="f-max">max_tokens</Label>
                <Input
                  id="f-max"
                  type="number"
                  min={1}
                  value={form.max_tokens}
                  onChange={(e) => setField('max_tokens', e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="f-timeout">超时 (ms)</Label>
                <Input
                  id="f-timeout"
                  type="number"
                  min={1000}
                  step={1000}
                  value={form.timeout_ms}
                  onChange={(e) => setField('timeout_ms', e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="f-interval">间隔 (分钟)</Label>
                <Input
                  id="f-interval"
                  type="number"
                  min={1}
                  value={form.interval_minutes}
                  onChange={(e) => setField('interval_minutes', e.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label htmlFor="f-enabled">启用定时探测</Label>
                <p className="text-xs text-muted-foreground">停用后不再自动探测，仍可手动探测</p>
              </div>
              <Switch
                id="f-enabled"
                checked={form.enabled}
                onCheckedChange={(v) => setField('enabled', v)}
              />
            </div>

            {testResult ? (
              testResult.status === 'ok' ? (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm">
                  连接成功 — {fmtTps(testResult.tps)} tokens/s · 首字 {fmtMs(testResult.ttft_ms)} ·
                  总耗时 {fmtMs(testResult.total_ms)}
                  {testResult.estimated === 1 ? '（token 数为估算值）' : ''}
                </div>
              ) : (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  连接失败（
                  {ERROR_TYPE_LABELS[testResult.error_type ?? ''] ?? testResult.error_type ?? '未知'}
                  ）：{testResult.error_message}
                </div>
              )
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={testing} onClick={() => void testConnection()}>
              {testing ? <Loader2 className="size-4 animate-spin" /> : null}
              测试连接
            </Button>
            <div className="flex-1 sm:hidden" />
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除模型？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleting?.name}」及其全部探测记录，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void confirmDelete()
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
