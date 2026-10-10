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
      <header className="panel-glass sticky top-0 z-40 border-b border-border/60">
        {/* 顶栏扫描线：青→紫渐变 */}
        <div className="scanline absolute inset-x-0 top-0" aria-hidden />
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
          <div className="flex items-center gap-2.5">
            <span className="relative grid size-7 place-items-center rounded-md border border-primary/30 bg-primary/10 shadow-glow">
              <Activity className="size-4 text-primary" />
            </span>
            <span className="text-tech-gradient text-[15px] font-bold tracking-tight">ModelMonitor</span>
          </div>
          <nav className="flex items-center gap-1">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors duration-200 hover:bg-accent/70 hover:text-foreground',
                    isActive &&
                      'bg-primary/10 font-medium text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]'
                  )
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  )
}