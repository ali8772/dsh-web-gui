/**
 * dsh-whale-pet — client half.
 *
 * 把大肥鲸桌面宠物注册进 `shell.overlay`（frame-wide 悬浮层，additive list
 * slot）：不占用任何布局席位，悬浮于 GUI 之上；数据来自宿主路由
 * `/api/whale-pet/state`（每 60s 轮询）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WhalePetWidget, attachTaskSource } from './widget.tsx'
import style from './style.css'

export const name = 'dsh-whale-pet'
export const inject = ['slots', 'sessions']

export function apply(ctx: Context): void {
  // 注入当前会话任务状态（running + 标题），供气泡任务进度栏使用
  // 直接用 inject 提供的 ctx.sessions（比 ctx.get 更稳）
  const sessionsCtx = (ctx as unknown as { sessions?: { list?: unknown; open?: (id: string) => void } }).sessions
  const openSession = typeof sessionsCtx?.open === 'function'
    ? (id: string): void => sessionsCtx?.open?.(id)
    : undefined
  attachTaskSource(sessionsCtx?.list as never, openSession)
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.setAttribute('data-dsh-plugin', 'dsh-whale-pet')
    tag.textContent = style
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-whale-pet: styles')

  ctx.slots.inject(
    'shell.overlay',
    () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-whale-pet',
      order: 200,
    }, WhalePetWidget),
    'dsh-whale-pet: whale pet overlay',
  )
}
