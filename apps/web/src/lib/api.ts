import type {
  ListProbesParams,
  Model,
  ModelInput,
  ModelsResponse,
  ProbeResult,
  ProbesResponse,
  RangeKey,
  Settings,
  Summary,
} from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
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
    throw new Error(msg)
  }
  return (await res.json()) as T
}

export const api = {
  listModels: () => request<ModelsResponse>('/models'),

  getModel: (id: number) => request<Model>(`/models/${id}`),

  createModel: (body: ModelInput) =>
    request<Model>('/models', { method: 'POST', body: JSON.stringify(body) }),

  updateModel: (id: number, body: Partial<ModelInput>) =>
    request<Model>(`/models/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  deleteModel: (id: number) => request<{ ok: boolean }>(`/models/${id}`, { method: 'DELETE' }),

  probeModel: (id: number) =>
    request<ProbeResult>(`/models/${id}/probe`, { method: 'POST' }),

  probeTest: (body: { base_url: string; api_key: string; model: string; prompt?: string; max_tokens?: number; timeout_ms?: number }) =>
    request<ProbeResult>('/probe-test', { method: 'POST', body: JSON.stringify(body) }),

  listRemoteModels: (body: { base_url: string; api_key: string }) =>
    request<{ items: string[]; url: string }>('/models-list', { method: 'POST', body: JSON.stringify(body) }),

  modelSummary: (id: number, range: RangeKey) =>
    request<Summary>(`/models/${id}/summary?range=${range}`),

  listProbes: (params: ListProbesParams = {}) => {
    const qs = new URLSearchParams()
    if (params.model_id != null) qs.set('model_id', String(params.model_id))
    if (params.status) qs.set('status', params.status)
    if (params.range) qs.set('range', params.range)
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.offset != null) qs.set('offset', String(params.offset))
    if (params.order) qs.set('order', params.order)
    const s = qs.toString()
    return request<ProbesResponse>(`/probes${s ? `?${s}` : ''}`)
  },

  getSettings: () => request<Settings>('/settings'),
}
