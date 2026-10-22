import { useCallback, useEffect, useState } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/app-shell'
import { LoginPage } from '@/components/login-page'
import { DashboardPage } from '@/pages/dashboard'
import { ModelsPage } from '@/pages/models'
import { RecordsPage } from '@/pages/records'
import { AUTH_EXPIRED_EVENT } from '@/lib/api'
import { clearToken, hasToken } from '@/lib/auth'

export default function App() {
  // 是否有可用令牌：决定显示登录页还是主界面。
  // 后端未启用 AUTH_TOKEN 时，令牌为空也能正常访问 —— 登录页会因
  // /api/settings 返回 200 而直接放行。
  const [authed, setAuthed] = useState(() => hasToken())

  const onAuthExpired = useCallback(() => {
    clearToken()
    setAuthed(false)
  }, [])

  useEffect(() => {
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired)
  }, [onAuthExpired])

  return (
    // 默认 light，支持 light / dark / system；默认 disableTransitionOnChange
    <ThemeProvider>
      <HashRouter>
        {authed ? (
          <AppShell>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/records" element={<RecordsPage />} />
            </Routes>
          </AppShell>
        ) : (
          <LoginPage onSuccess={() => setAuthed(true)} />
        )}
        <Toaster richColors position="top-center" />
      </HashRouter>
    </ThemeProvider>
  )
}
