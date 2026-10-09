export type RangeKey = '1h' | '6h' | '24h' | '7d'

export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: '1h', label: '近 1 小时' },
  { value: '6h', label: '近 6 小时' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
]

/** 供应商：OpenAI 兼容接入点，探测参数挂在供应商上 */
export interface Provider {
  id: number
  name: string
  base_url: string
  api_key: string
  prompt: string
  max_tokens: number
  timeout_ms: number
  interval_minutes: number
  probe_gap_ms: number
  enabled: number
  created_at: string
  updated_at: string
}

export interface ProviderInput {
  name: string
  base_url: string
  api_key: string
  prompt: string
  max_tokens: number
  timeout_ms: number
  interval_minutes: number
  probe_gap_ms: number
  enabled: boolean
}

/** 模型（联表视图）：挂在供应商之下 */
export interface ModelRow {
  id: number
  provider_id: number
  model: string
  enabled: number
  thinking_strength: string
  created_at: string
  provider_name: string
  base_url: string
  provider_enabled: number
  interval_minutes: number
}

export interface ModelWithLatest extends ModelRow {
  latest?: ProbeResult | null
}

export interface ProbeResult {
  id?: number
  model_id: number | null
  status: 'ok' | 'error'
  ttft_ms: number | null
  total_ms: number | null
  completion_tokens: number | null
  estimated: 0 | 1
  tps: number | null
  avg_tps: number | null
  reasoning_tokens: number | null
  reasoning_ms: number | null
  reasoning_tps: number | null
  content_tokens: number | null
  prompt_tokens: number | null
  error_type: string | null
  error_message: string | null
  created_at: string
}

export interface MetricStats {
  avg: number | null
  p50?: number | null
  p95?: number | null
  max?: number | null
}

export interface SummaryStats {
  total: number
  ok_count: number
  error_count: number
  success_rate: number | null
  tps: MetricStats
  ttft_ms: MetricStats
  total_ms: MetricStats
}

export interface Summary {
  model_id: number
  range: RangeKey
  latest: ProbeResult | null
  stats: SummaryStats
}

export interface ProbesResponse {
  total: number
  items: ProbeResult[]
}

export interface ModelsResponse {
  items: ModelWithLatest[]
}

export interface ListProbesParams {
  model_id?: number | null
  status?: 'ok' | 'error' | ''
  range?: RangeKey | ''
  limit?: number
  offset?: number
  order?: 'asc' | 'desc'
}

export interface Settings {
  default_interval_minutes: string
}

export const ERROR_TYPE_LABELS: Record<string, string> = {
  timeout: '超时',
  auth: '认证失败',
  rate_limit: '限流',
  server: '服务端错误',
  network: '网络错误',
  stream_aborted: '流中断',
  parse: '解析异常',
  invalid_model: '模型不存在',
  no_content: '无输出内容',
  no_response_body: '无响应体',
  http_error: 'HTTP 错误',
}
