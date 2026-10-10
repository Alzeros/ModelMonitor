/**
 * 仅开发模式的页内错误浮层。
 * 背景：IDE 预览的错误面板只显示两行摘要（如 "Script error."），看不到
 * 具体来源；本浮层把任何未捕获错误（含 Promise 拒绝）的完整消息与调用栈
 * 直接渲染在页面左下角，方便定位偶发的竞态类报错。
 * 生产构建不注入（import.meta.env.DEV 为 false 时直接返回）。
 * 双击浮层可清除内容。
 */
export function installDevErrorOverlay(): void {
  if (!import.meta.env.DEV) return
  if (typeof window === 'undefined') return

  const box = document.createElement('div')
  box.setAttribute('data-mm-dev-errors', '')
  Object.assign(box.style, {
    position: 'fixed',
    left: '8px',
    right: '8px',
    bottom: '8px',
    maxHeight: '42vh',
    overflow: 'auto',
    zIndex: '2147483647',
    background: 'rgba(8, 10, 16, 0.94)',
    color: '#ff9d9d',
    font: '11px/1.5 Consolas, Menlo, monospace',
    padding: '8px 10px',
    borderRadius: '8px',
    boxShadow: '0 0 0 1px rgba(255, 90, 90, 0.4)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    display: 'none',
    cursor: 'auto',
  } satisfies Partial<CSSStyleDeclaration>)
  box.addEventListener('dblclick', () => {
    box.textContent = ''
    box.style.display = 'none'
  })

  let count = 0
  const append = (kind: string, summary: string, stack?: string | null) => {
    count += 1
    box.style.display = 'block'
    const item = document.createElement('div')
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const stackLines = stack ? `\n${stack.split('\n').slice(0, 6).join('\n')}` : ''
    item.textContent = `#${count} [${kind} ${time}] ${summary}${stackLines}`
    item.style.cssText = 'padding:3px 0 5px;border-top:1px dashed rgba(255,120,120,.35)'
    box.appendChild(item)
  }

  // capture=true：可抓到资源加载 / 责任分散在子节点的错误
  window.addEventListener('error', (e: Event) => {
    if (e instanceof ErrorEvent) {
      append('error', e.message || '(无消息)', e.error?.stack ?? null)
    } else {
      // 资源类错误（script/img 加载失败）
      const tag = (e.target as HTMLElement | null)?.tagName ?? '(未知目标)'
      append('resource', `${tag} 加载失败`, null)
    }
  }, true)

  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    const msg = r instanceof Error ? r.message : String(r)
    append('promise-rejection', msg, r instanceof Error ? r.stack : null)
  })

  const root = document.documentElement
  if (root) root.appendChild(box)
}