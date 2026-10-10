import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  ALL_SECTION_IDS,
  DASHBOARD_SECTIONS,
  SECTION_GROUP_ORDER,
  type SectionId,
} from '@/lib/dashboard-sections'
import { cn } from '@/lib/utils'

/**
 * 顶部「显示区块」开关面板。
 *
 * 采用下拉面板而不是「每个区块就地开关」：区块隐藏后就地开关也会一起消失，
 * 会形成「关掉就再也开不回来」的死锁。
 */
export function SectionToggles({
  hidden,
  onChange,
}: {
  hidden: ReadonlySet<SectionId>
  onChange: (next: Set<SectionId>) => void
}) {
  const total = DASHBOARD_SECTIONS.length
  const visibleCount = total - hidden.size

  const setOne = (id: SectionId, on: boolean) => {
    const next = new Set(hidden)
    if (on) next.delete(id)
    else next.add(id)
    onChange(next)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2" aria-label="选择要显示的区块">
          <SlidersHorizontal className="size-4" />
          显示区块
          <span
            className={cn(
              'font-mono text-xs tabular-nums',
              hidden.size > 0 ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {visibleCount}/{total}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-0 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">显示区块</span>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onChange(new Set())}
            >
              全部显示
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onChange(new Set(ALL_SECTION_IDS))}
            >
              全部隐藏
            </Button>
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1.5">
          {SECTION_GROUP_ORDER.map((group) => {
            const items = DASHBOARD_SECTIONS.filter((s) => s.group === group)
            if (!items.length) return null
            return (
              <div key={group} className="mb-1 last:mb-0">
                <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
                  {group}
                </p>
                {items.map((s) => (
                  <div
                    key={s.id}
                    role="presentation"
                    onClick={() => setOne(s.id, hidden.has(s.id))}
                    className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{s.label}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{s.hint}</p>
                    </div>
                    <Switch
                      checked={!hidden.has(s.id)}
                      onCheckedChange={(v) => setOne(s.id, v)}
                      // 阻止冒泡：开关自己处理，避免与整行的点击叠加成「切两次」
                      onClick={(e) => e.stopPropagation()}
                      aria-label={s.label}
                    />
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
