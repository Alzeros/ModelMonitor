import { useState, type FormEvent } from 'react'
import { Activity, KeyRound, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setToken } from '@/lib/auth'
import { api } from '@/lib/api'

/**
 * 登录页：输入访问令牌。
 *
 * 令牌由后端 AUTH_TOKEN 环境变量决定，前端只做持有与携带。
 * 提交后先用该令牌请求一次 /api/settings 验证有效性，
 * 失败则留在本页并提示，不写入存储。
 */
export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const token = value.trim()
    if (!token) {
      setError('请输入访问令牌')
      return
    }
    setChecking(true)
    setError('')
    // 先写入再验证：api.request 会带上这个头；失败时清除
    setToken(token)
    try {
      await api.getSettings()
      onSuccess()
    } catch (err) {
      setToken('')
      const status = (err as { status?: number }).status
      setError(status === 401 ? '令牌无效' : `验证失败：${(err as Error).message}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 grid size-11 place-items-center rounded-xl border border-primary/25 bg-primary/10">
            <Activity className="size-5 text-primary" />
          </span>
          <h1 className="text-lg font-semibold tracking-tight">ModelMonitor</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">请输入访问令牌以继续</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="password"
              value={value}
              autoFocus
              autoComplete="current-password"
              placeholder="访问令牌"
              aria-label="访问令牌"
              aria-invalid={Boolean(error)}
              className="h-10 pl-9 font-mono"
              onChange={(e) => {
                setValue(e.target.value)
                if (error) setError('')
              }}
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={checking}>
            {checking ? <Loader2 className="size-4 animate-spin" /> : null}
            {checking ? '验证中…' : '登录'}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
          令牌由服务端环境变量 <code className="font-mono">AUTH_TOKEN</code> 定义。
          <br />
          未设置时服务不启用认证，仅建议本地使用。
        </p>
      </div>
    </div>
  )
}
