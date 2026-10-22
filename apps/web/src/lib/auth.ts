/**
 * 访问令牌管理。
 *
 * 令牌由后端环境变量 AUTH_TOKEN 定义，前端不参与其生成，
 * 只负责持有与携带。存储在 localStorage（XSS 可读），
 * 因此真正的防护必须依赖 HTTPS 反向代理 + 令牌本身的强度。
 */

const STORAGE_KEY = 'modelmonitor.token'

let memoryToken: string | null = null
let storageAvailable = true

/** 读取已保存的令牌；localStorage 不可用时退回内存（刷新即失效） */
export function getToken(): string {
  if (memoryToken) return memoryToken
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v) {
      memoryToken = v
      return v
    }
  } catch {
    storageAvailable = false
  }
  return ''
}

export function setToken(token: string): void {
  const t = token.trim()
  memoryToken = t || null
  try {
    if (t) localStorage.setItem(STORAGE_KEY, t)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    storageAvailable = false
  }
}

export function clearToken(): void {
  memoryToken = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function hasToken(): boolean {
  return getToken().length > 0
}

/** localStorage 是否可用（隐私模式等） */
export function isStorageAvailable(): boolean {
  return storageAvailable
}

/** 授权头；无令牌时返回空对象 */
export function authHeader(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}
