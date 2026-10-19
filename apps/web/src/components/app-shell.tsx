import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useTheme } from '@/components/theme-provider'
import { Activity, Boxes, Moon, ScrollText, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const NAV = [
  { to: '/', label: '仪表盘', icon: Activity, end: true },
  { to: '/models', label: '模型管理', icon: Boxes, end: false },
  { to: '/records', label: '探测记录', icon: ScrollText, end: false },
]

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="切换主题"
      className="cursor-pointer text-muted-foreground transition-colors hover:text-primary"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:gap-6">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="grid size-7 place-items-center rounded-md border border-primary/25 bg-primary/10">
              <Activity className="size-4 text-primary" />
            </span>
            {/* 窄屏隐藏品牌文字，给导航留出空间 */}
            <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">
              ModelMonitor
            </span>
          </div>
          <nav className="flex shrink-0 items-center gap-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={label}
                className={({ isActive }) =>
                  cn(
                    'flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground sm:px-3',
                    isActive && 'bg-primary/10 font-medium text-primary'
                  )
                }
              >
                <Icon className="size-4 shrink-0" />
                {/* 窄屏只留图标，宽屏才显示文字 */}
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto shrink-0">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  )
}