import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * 轻量主题 Provider，替代 next-themes。
 * 背景：next-themes 渲染时注入内联 <script>，会触发 react-dom@19.3 新增的
 * 开发期警告（Float 资源检查），脚本放到 index.html <head> 中可彻底绕开，
 * 且防闪烁效果不变（先于 React 挂载执行）。
 *
 * 保留本应用实际用到的能力：
 * - html 的 .light / .dark class 切换（与 previous attribute="class" 一致）
 * - light / dark / system 三态，system 跟随系统偏好实时变化
 * - localStorage 记忆（键名沿用 next-themes 的 'theme'，旧数据无缝迁移）
 * - 多标签页同步（storage 事件）
 * - disableTransitionOnChange：切换时临时禁用全局过渡，避免颜色混合闪烁
 */

export type Theme = 'dark' | 'light' | 'system'
type Resolved = 'dark' | 'light'

const STORAGE_KEY = 'theme'
const DEFAULT_THEME: Theme = 'light'
const MEDIA_DARK = '(prefers-color-scheme: dark)'

interface ThemeCtx {
  /** 当前选择：'dark' | 'light' | 'system' */
  theme: Theme
  /** 实际生效的主题 */
  resolvedTheme: Resolved
  setTheme: (t: Theme) => void
}

const Ctx = createContext<ThemeCtx | null>(null)

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
  return DEFAULT_THEME
}

function resolveTheme(raw: Theme): Resolved {
  if (raw === 'system') {
    try {
      return window.matchMedia(MEDIA_DARK).matches ? 'dark' : 'light'
    } catch {
      return 'dark'
    }
  }
  return raw
}

export function ThemeProvider({
  children,
  /** 切换主题时临时禁用全局过渡动画 */
  disableTransitionOnChange = true,
}: {
  children: ReactNode
  disableTransitionOnChange?: boolean
}) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)
  const [resolvedTheme, setResolvedTheme] = useState<Resolved>(() => resolveTheme(theme))
  const [systemTick, setSystemTick] = useState(0) // 系统偏好变化时强制重算

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t)
    } catch {
      /* ignore */
    }
    setThemeState(t)
  }, [])

  // 把选择应用到 <html>（index.html 的内联脚本已先行设置过一次，此处保持后续一致）
  useEffect(() => {
    void systemTick
    let cleanup: (() => void) | undefined
    if (disableTransitionOnChange) {
      const style = document.createElement('style')
      style.setAttribute('data-theme-transition', '')
      style.textContent = '*,*::before,*::after{transition:none!important}'
      document.head.appendChild(style)
      cleanup = () => style.remove()
    }
    const next = resolveTheme(theme)
    const root = document.documentElement
    root.classList.toggle('dark', next === 'dark')
    root.classList.toggle('light', next !== 'dark')
    setResolvedTheme(next)
    if (cleanup) requestAnimationFrame(() => requestAnimationFrame(cleanup))
  }, [theme, systemTick, disableTransitionOnChange])

  // theme=system 时实时跟随系统深浅色切换
  useEffect(() => {
    const mq = window.matchMedia(MEDIA_DARK)
    const onMedia = () => setSystemTick((t) => t + 1)
    mq.addEventListener('change', onMedia)
    return () => mq.removeEventListener('change', onMedia)
  }, [])

  // 多标签页主题同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const v = e.newValue
      if (e.key === STORAGE_KEY && (v === 'dark' || v === 'light' || v === 'system')) {
        setThemeState(v)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const value = useMemo<ThemeCtx>(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useTheme 必须在 <ThemeProvider> 内使用')
  return ctx
}