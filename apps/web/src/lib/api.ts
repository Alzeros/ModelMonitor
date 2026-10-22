import { authHeader } from './auth'
import type {
  ListProbesParams,
  ModelRow,
  ModelsResponse,
  ProbeResult,
  ProbesResponse,
  Provider,
  ProviderInput,
  RangeKey,
  Settings,
  Summary,
} from './types'

/** 认证失效事件名：登录页据此切回登录界面 */
export const AUTH_EXPIRED_EVENT = 'modelmonitor:auth-expired'

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...authHeader(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const data = (await res.json()) as { error?: string; errors?: string[] }
      if (data.error) msg = data.error
      if (Array.isArray(data.errors) && data.errors.length) msg = data.errors.join('；')
    } catch {
      /* ignore */
    }
    // 401：令牌缺失或失效 —— 通知上层切回登录页
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
    }
    throw new ApiError(msg, res.status)
  }
  return (await res.json()) as T
}

export const api = {
  // 供应商
  listProviders: () => request<{ items: Provider[] }>('/providers'),
  createProvider: (body: ProviderInput) =>
    request<Provider>('/providers', { method: 'POST', body: JSON.stringify(body) }),
  updateProvider: (id: number, body: Partial<ProviderInput>) =>
    request<Provider>(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteProvider: (id: number) =>
    request<{ ok: boolean }>(`/providers/${id}`, { method: 'DELETE' }),

  // 模型（供应商之下）
  listModels: () => request<ModelsResponse>('/models'),
  addProviderModels: (providerId: number, models: string[], thinkingStrength = 'default', displayName?: string) =>
    request<{ added: number; skipped: string[] }>(`/providers/${providerId}/models`, {
      method: 'POST',
      body: JSON.stringify({
        models,
        thinking_strength: thinkingStrength,
        ...(displayName?.trim() ? { display_name: displayName.trim() } : {}),
      }),
    }),
  updateModel: (id: number, patch: { enabled?: boolean; thinking_strength?: string; display_name?: string }) =>
    request<ModelRow>(`/models/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteModel: (id: number) => request<{ ok: boolean }>(`/models/${id}`, { method: 'DELETE' }),

  // 探测
  probeModel: (id: number) => request<ProbeResult>(`/models/${id}/probe`, { method: 'POST' }),

  probeTest: (body: {
    base_url: string
    api_key: string
    model: string
    prompt?: string
    max_tokens?: number
    timeout_ms?: number
  }) => request<ProbeResult>('/probe-test', { method: 'POST', body: JSON.stringify(body) }),

  listRemoteModels: (body: { base_url: string; api_key: string }) =>
    request<{ items: string[]; url: string }>('/models-list', { method: 'POST', body: JSON.stringify(body) }),

  /**
   * 用「已保存的」供应商密钥拉取模型列表。
   * 密钥留在服务端，不经浏览器 —— 编辑态与「添加模型」都走这个接口。
   */
  listRemoteModelsForProvider: (providerId: number) =>
    request<{ items: string[]; url: string }>(`/providers/${providerId}/models-list`, { method: 'POST' }),

  // 指标与设置
  modelSummary: (id: number, range: RangeKey) =>
    request<Summary>(`/models/${id}/summary?range=${range}`),

  listProbes: (params: ListProbesParams = {}) => {
    const qs = new URLSearchParams()
    if (params.model_id != null) qs.set('model_id', String(params.model_id))
    if (params.status) qs.set('status', params.status)
    if (params.valid != null) qs.set('valid', String(params.valid))
    if (params.range) qs.set('range', params.range)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.offset != null) qs.set('offset', String(params.offset))
    if (params.order) qs.set('order', params.order)
    const s = qs.toString()
    return request<ProbesResponse>(`/probes${s ? `?${s}` : ''}`)
  },

  getSettings: () => request<Settings>('/settings'),
}
