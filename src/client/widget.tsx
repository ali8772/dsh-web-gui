/**
 * 大肥鲸桌面宠物组件：DeepSeek 品牌蓝的圆滚滚鲸鱼，悬浮于 GUI 角落。
 * - 每 60s 轮询 `/api/whale-pet/state`，实时余额 + 今日/近 7 天消费
 * - 点击鲸鱼循环切换显示：余额 → 今日消费 → 近 7 天消费
 * - 按住可拖拽，位置记忆在 localStorage
 * - 数据异常时鲸鱼变「沮丧」并显示错误气泡
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import whaleChanUrl from '../../assets/whale-chan.png'

export interface BalanceInfo {
  readonly currency: string
  readonly totalBalance: number | null
  readonly grantedBalance: number | null
  readonly toppedUpBalance: number | null
}

export interface PetState {
  readonly ok: boolean
  readonly fetchedAt: number
  readonly balance: {
    readonly available: boolean
    readonly currency: string
    readonly totalBalance: number | null
    readonly grantedBalance: number | null
    readonly toppedUpBalance: number | null
    readonly infos: readonly BalanceInfo[]
  } | null
  readonly spend: {
    readonly today: { readonly amount: number; readonly amountUsd: number | null; readonly calls: number; readonly source: 'balance' }
    readonly days7: { readonly amount: number; readonly amountUsd: number | null; readonly calls: number; readonly source: 'balance' }
  }
}

const REFRESH_MS = 60_000
const POS_KEY = 'dsh-whale-pet:pos'
const PET_W = 170
const PET_H = 240 // 容纳放大后的鲸鱼娘（129×225 + 底部偏移）

const MODE_LABELS = ['余额', '消费', '任务进度'] as const

// 任务进度页滚动：最多同时显示 TASK_VIEW_SIZE 条，超过时每 TASK_SCROLL_MS 向上滚动一条
const TASK_VIEW_SIZE = 5
const TASK_SCROLL_MS = 5_000
const TASK_ROW_H = 40 // 与 CSS .wp-task-track .wp-task-row 高度保持一致

// ---- 高峰时段（北京时间，与官方峰谷定价窗口一致） ----
const PEAK_TZ = 'Asia/Shanghai'
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [[9, 12], [14, 18]]

interface PeakStatus {
  readonly active: boolean
  readonly hour: number
}

/** 北京时间当前小时（0-23）；极端环境取本地小时兜底。 */
function beijingHour(now: Date): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: PEAK_TZ, hour: 'numeric', hour12: false }).format(now)) % 24
  } catch {
    return now.getHours()
  }
}

/** 当前是否处于高峰时段（窗口 [start, end) 闭开区间）。 */
function computePeak(now: Date = new Date()): PeakStatus {
  const hour = beijingHour(now)
  return { active: PEAK_WINDOWS.some(([start, end]) => hour >= start && hour < end), hour }
}

/** 单条任务的进度说明文案。 */
function taskStageText(p: TaskProgressInfo | undefined): string {
  if (p === undefined) return '获取进度中…'
  if (p.pct !== null) {
    if (p.current !== null && p.current !== '') return '正在：' + p.current
    return `已完成 ${p.done}/${p.total}`
  }
  if (p.stage === 'tool' && p.tool !== null) return '正在执行 ' + p.tool
  if (p.stage === 'thinking') return p.turn !== null ? `第 ${p.turn} 轮 · 思考中…` : '思考中…'
  return '准备中…'
}

// ---- 当前任务状态源（由插件入口注入 ctx.sessions.list） ----
/** 会话真实进度（来自宿主回放会话日志：todo 清单 + 工具/轮次信号）。 */
export interface TaskProgressInfo {
  /** todo 清单总数（0 = 未使用 todo 清单）。 */
  readonly total: number
  readonly done: number
  /** 完成百分比 0-100；无 todo 清单时为 null。 */
  readonly pct: number | null
  /** 当前 in_progress 的 todo 内容。 */
  readonly current: string | null
  readonly stage: 'tool' | 'thinking' | 'idle'
  readonly tool: string | null
  readonly turn: number | null
  readonly step: number | null
}
export interface TaskItem {
  id: string
  title: string
  progress?: TaskProgressInfo
}
export interface TaskInfo {
  running: boolean
  count: number
  items: readonly TaskItem[]
}
let taskCurrent: TaskInfo = { running: false, count: 0, items: [] }
const taskListeners = new Set<(t: TaskInfo) => void>()
/** 点击任务行跳转会话页：由 attachTaskSource 注入 ctx.sessions.open。 */
let taskOpenSession: ((id: string) => void) | null = null

/** 跳转到指定会话页（任务进度栏点击行时调用）。 */
export function openTaskSession(id: string): void {
  try {
    taskOpenSession?.(id)
  } catch {
    // 跳转失败不影响宠物
  }
}

interface TaskListLike {
  subscribe(cb: () => void): () => void
  getSnapshot(): { current?: string; byId: Record<string, { running: boolean; displayTitle: string; updatedAt: number }> }
}

/** 收集工作区所有正在运行的会话（按最近更新排序，最多 10 条），并从宿主拉取真实进度。 */
export function attachTaskSource(list: TaskListLike | null | undefined, open?: ((id: string) => void) | null): void {
  if (list === null || list === undefined) return
  taskOpenSession = typeof open === 'function' ? open : null
  // E2E/调试用：注入的假任务优先于真实数据
  let debugOverride: TaskInfo | null = null
  let progressById = new Map<string, TaskProgressInfo>()
  let lastProgressFetch = 0

  /** POST 宿主 /api/whale-pet/tasks，把真实进度合并回当前任务列表。 */
  const fetchProgress = async (ids: readonly string[]): Promise<void> => {
    const now = Date.now()
    if (ids.length === 0) return
    if (now - lastProgressFetch < 2500) return
    lastProgressFetch = now
    try {
      const response = await fetch('/api/whale-pet/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
        cache: 'no-store',
      })
      if (!response.ok) return
      const body = (await response.json()) as {
        ok?: boolean
        tasks?: Array<{
          id: string
          found: boolean
          totalTodos?: number
          doneTodos?: number
          currentTodo?: string | null
          pct?: number | null
          stage?: 'tool' | 'thinking' | 'idle'
          tool?: string | null
          turn?: number | null
          step?: number | null
        }>
      }
      if (body === null || body.ok !== true || !Array.isArray(body.tasks)) return
      const next = new Map<string, TaskProgressInfo>()
      for (const row of body.tasks) {
        if (row.found !== true) continue
        next.set(row.id, {
          total: typeof row.totalTodos === 'number' ? row.totalTodos : 0,
          done: typeof row.doneTodos === 'number' ? row.doneTodos : 0,
          pct: typeof row.pct === 'number' ? row.pct : null,
          current: row.currentTodo ?? null,
          stage: row.stage === 'tool' ? 'tool' : row.stage === 'thinking' ? 'thinking' : 'idle',
          tool: row.tool ?? null,
          turn: row.turn ?? null,
          step: row.step ?? null,
        })
      }
      progressById = next
    } catch {
      // 拉取失败：保留上一次进度
    }
    const items = taskCurrent.items.map((item) => ({ ...item, progress: progressById.get(item.id) }))
    taskCurrent = { ...taskCurrent, items }
    for (const listener of taskListeners) listener(taskCurrent)
  }

  const update = (): void => {
    if (debugOverride !== null) {
      taskCurrent = debugOverride
      for (const listener of taskListeners) listener(taskCurrent)
      return
    }
    try {
      const snap = list.getSnapshot()
      const byId = snap.byId
      const items = Object.keys(byId)
        .filter((id) => byId[id]?.running === true)
        .sort((a, b) => (byId[b]?.updatedAt ?? 0) - (byId[a]?.updatedAt ?? 0))
        .slice(0, 10)
        .map((id) => ({ id, title: byId[id]?.displayTitle ?? '', progress: progressById.get(id) }))
      taskCurrent = { running: items.length > 0, count: items.length, items }
    } catch {
      taskCurrent = { running: false, count: 0, items: [] }
    }
    for (const listener of taskListeners) listener(taskCurrent)
    void fetchProgress(taskCurrent.items.map((item) => item.id))
  }
  update()
  list.subscribe(update)
  // 轮询兜底：订阅偶发不触发时仍能刷新任务状态
  const timer = window.setInterval(update, 5000)
  // 调试钩子：E2E/排查用（set 注入假任务，clear 恢复真实数据）
  try {
    ;(window as unknown as Record<string, unknown>).__whaleTaskDebug = {
      get: () => ({ ...taskCurrent }),
      getCurrent: () => {
        try {
          return list.getSnapshot().current
        } catch {
          return undefined
        }
      },
      getSessions: () => {
        try {
          return list.getSnapshot().ids
        } catch {
          return []
        }
      },
      open: (id: string) => openTaskSession(id),
      set: (items: readonly TaskItem[]) => {
        debugOverride = { running: items.length > 0, count: items.length, items: [...items] }
        taskCurrent = debugOverride
        for (const listener of taskListeners) listener(taskCurrent)
      },
      clear: () => {
        debugOverride = null
        update()
      },
    }
  } catch { /* ignore */ }
  // 不做清理：插件与页面同生命周期
  void timer
}

export function subscribeTask(cb: (t: TaskInfo) => void): () => void {
  taskListeners.add(cb)
  cb(taskCurrent)
  return () => { taskListeners.delete(cb) }
}

interface Pos {
  x: number
  y: number
}

function defaultPos(): Pos {
  return {
    x: Math.max(8, window.innerWidth - PET_W - 20),
    y: Math.max(8, window.innerHeight - PET_H - 20),
  }
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown }
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number' && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
        return clampPos({ x: parsed.x, y: parsed.y })
      }
    }
  } catch {
    // ignore
  }
  return defaultPos()
}

function clampPos(pos: Pos): Pos {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return {
    x: Math.min(Math.max(8, pos.x), Math.max(8, vw - PET_W - 8)),
    y: Math.min(Math.max(8, pos.y), Math.max(8, vh - PET_H - 8)),
  }
}

function formatMoney(amount: number, currency: string, estimate = false): string {
  const symbol = currency === 'USD' ? '$' : '¥'
  const prefix = estimate ? '≈' : ''
  if (amount < 0.005) return `${prefix}${symbol}0.00`
  if (amount < 0.01) return `${prefix}${symbol}<0.01`
  return `${prefix}${symbol}${amount.toFixed(2)}`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}


interface BubbleContent {
  title: string
  sub: string
  cls: string
}

function bubbleFor(mode: number, data: PetState | null, error: string | null, task: TaskInfo): BubbleContent {
  if (data === null && error !== null) {
    return { title: '拿不到数据了', sub: '点我重试 · 每 60s 自动刷新', cls: 'wp-error' }
  }
  if (data === null) {
    return { title: '加载中…', sub: '正在询问深海', cls: '' }
  }
  const currency = data.balance?.currency ?? 'CNY'
  if (mode === 0) {
    const balance = data.balance
    if (balance === null || balance.totalBalance === null) {
      return { title: '余额不可用', sub: '检查 DEEPSEEK_API_KEY', cls: 'wp-error' }
    }
    const low = balance.currency === 'CNY' && balance.totalBalance < 10
    const parts: string[] = [`更新于 ${formatTime(data.fetchedAt)}`]
    if (balance.toppedUpBalance !== null && balance.grantedBalance !== null) {
      parts.push(`充值 ${formatMoney(balance.toppedUpBalance, balance.currency)}`)
    }
    return {
      title: `余额 ${formatMoney(balance.totalBalance, balance.currency)}`,
      sub: parts.join(' · '),
      cls: low ? 'wp-low-balance' : '',
    }
  }
  if (mode === 1) {
    // 消费页：今日 + 近 7 天合并展示；金额以账户余额变化为准
    return { title: '消费', sub: '', cls: '' }
  }
  // mode === 2：任务进度页（仅在有任务时进入，无任务时 modeCount=2）
  const count = task.items.length
  const current = count > 0 ? task.items[0] : null
  const title = '⏳ 任务进度'
  const sub = count > 1 ? count + ' 个任务进行中' : (current !== null ? current.title : '空闲')
  return { title, sub, cls: 'normal', currency: 'CNY', approx: false, calls: 0 }
}

export interface WhalePetWidgetProps {
  // slots 运行时注入的 props；本组件不消费具体字段
  [key: string]: unknown
}

/** 桌面宠物主组件。 */
export function WhalePetWidget(_props: WhalePetWidgetProps): JSX.Element {
  const [data, setData] = useState<PetState | null>(null)
  const [bgLight, setBgLight] = useState(false)   // 页面背景是否为浅色（白底 -> 黑气泡白字）
  const [task, setTask] = useState<TaskInfo>({ running: false, count: 0, items: [] })
  const [scrollOffset, setScrollOffset] = useState(0)   // 任务区滚动偏移（行数）
  const [peak, setPeak] = useState<PeakStatus>(() => computePeak())   // 高峰时段（余额栏徽标）
  const taskRef = useRef(task)
  taskRef.current = task   // 拖拽 effect 的闭包需要读到最新任务状态
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [mode, setMode] = useState(0)
  const [pos, setPos] = useState<Pos>(() => loadPos())
  const [dragging, setDragging] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const petRef = useRef<HTMLDivElement | null>(null)
  const scrollSnapRef = useRef(false)   // 滚动回卷瞬间禁用过渡（内容相同，视觉无缝）
  const posRef = useRef(pos)
  posRef.current = pos
  const dragState = useRef<{
    startX: number
    startY: number
    origX: number
    origY: number
    curX: number
    curY: number
    moved: boolean
  } | null>(null)

  const refresh = async (): Promise<void> => {
    setFetching(true)
    try {
      const response = await fetch('/api/whale-pet/state', { cache: 'no-store', headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as PetState
      if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error('bad payload')
      setData(body)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    const onResize = (): void => {
      setPos((prev) => clampPos(prev))
    }
    window.addEventListener('resize', onResize)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // 订阅当前任务状态（running + 会话标题）
  useEffect(() => subscribeTask(setTask), [])

  // 高峰时段徽标：每 30s 检查一次，跨整点（12:00/18:00 等）及时翻转
  useEffect(() => {
    const timer = setInterval(() => {
      setPeak((prev) => {
        const next = computePeak()
        return prev.active === next.active && prev.hour === next.hour ? prev : next
      })
    }, 30_000)
    return () => clearInterval(timer)
  }, [])

  // 无任务时模式总数回 2，若当前在任务进度页则回落
  useEffect(() => {
    const count = task.running ? 3 : 2
    if (mode >= count) setMode(0)
  }, [task.running, mode])

  // 任务进度页自动滚动：超过 5 条时每 5s 向上滚动一条；列表变化或离开任务页时复位
  useEffect(() => {
    setScrollOffset(0)
    if (mode !== 2 || task.items.length <= TASK_VIEW_SIZE) return
    const timer = window.setInterval(() => {
      setScrollOffset((o) => {
        const n = task.items.length
        if (o + 1 > n) {
          // 回卷：偏移 n 时视口内容与 0 相同（track 复制了一份），瞬间跳回即可无缝
          scrollSnapRef.current = true
          setTimeout(() => { scrollSnapRef.current = false }, 80)
          return 0
        }
        return o + 1
      })
    }, TASK_SCROLL_MS)
    return () => window.clearInterval(timer)
  }, [mode, task.items.length])

  // 背景亮度检测：余额栏反色自适应（浅背景 -> 黑底白字；深背景 -> 白底黑字）
  useEffect(() => {
    const parseColor = (value: string): [number, number, number] | null => {
      const m = value.trim().match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
      const hex = value.trim().match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/)
      if (hex) {
        const h = hex[1]
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
        return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
      }
      return null
    }
    const detect = (): void => {
      let color = getComputedStyle(document.body).backgroundColor
      if (color === 'transparent' || color === 'rgba(0, 0, 0, 0)') {
        // 主题变量（ui-theme 设置在 html/body）
        const rootCs = getComputedStyle(document.documentElement)
        const themed = rootCs.getPropertyValue('--dsw-alias-bg-base').trim()
        if (themed !== '') color = themed
        else {
          const bodyVar = getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim()
          if (bodyVar !== '') color = bodyVar
        }
      }
      const rgb = parseColor(color)
      if (rgb === null) return
      const y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
      setBgLight(y > 150)
    }
    detect()
    // 主题切换/属性变化时重检
    const mo = new MutationObserver(() => detect())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] })
    mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] })
    const onTheme = (): void => detect()
    window.addEventListener('dsh:theme-change', onTheme)
    return () => {
      mo.disconnect()
      window.removeEventListener('dsh:theme-change', onTheme)
    }
  }, [])

  // 拖拽：按下捕获，位移 >4px 判定为拖动（此时不触发点击切换），松手提交位置。
  useEffect(() => {
    const pet = petRef.current
    if (pet === null) return

    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragState.current
      if (drag === null) return
      drag.curX = event.clientX - drag.startX
      drag.curY = event.clientY - drag.startY
      if (!drag.moved && Math.abs(drag.curX) + Math.abs(drag.curY) > 4) {
        drag.moved = true
        setDragging(true)
      }
      if (drag.moved) {
        pet.style.transition = 'none'
        pet.style.transform = `translate(${drag.origX + drag.curX}px, ${drag.origY + drag.curY}px)`
      }
    }

    const finishDrag = (): void => {
      const drag = dragState.current
      dragState.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', finishDrag)
      window.removeEventListener('pointercancel', finishDrag)
      if (drag === null) return
      pet.style.transition = ''
      setDragging(false)
      if (drag.moved) {
        const next = clampPos({ x: drag.origX + drag.curX, y: drag.origY + drag.curY })
        setPos(next)
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(next))
        } catch {
          // ignore
        }
      } else {
        // 单击 → 循环切换显示模式
        setMode((m) => (m + 1) % (taskRef.current.running ? 3 : 2))
      }
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      // 充值按钮/进度条/任务行上的按下不进入拖拽（避免点击它们触发模式切换/拖拽）
      const target = event.target as HTMLElement | null
      if (target !== null && typeof target.closest === 'function'
        && target.closest('.wp-recharge-btn, .wp-task-prog, .wp-task-row') !== null) return
      const start = posRef.current
      dragState.current = {
        startX: event.clientX,
        startY: event.clientY,
        origX: start.x,
        origY: start.y,
        curX: 0,
        curY: 0,
        moved: false,
      }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', finishDrag)
      window.addEventListener('pointercancel', finishDrag)
      event.preventDefault()
    }

    pet.addEventListener('pointerdown', onPointerDown)
    return () => {
      pet.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  // 有任务时点击切换为 3 页（第 3 页 = 任务进度）；无任务仍 2 页
  const modeCount = task.running ? 3 : 2
  // 任务进度页：最多同时显示 5 条；超过 5 条时每 5s 向上滚动一条（收集上限 10 条见 attachTaskSource）
  const taskCount = task.items.length
  const scrollOff = Math.min(scrollOffset, taskCount)
  const scrolling = taskCount > TASK_VIEW_SIZE
  // 滚动时 track 复制一份实现无缝回卷；偏移范围 0..taskCount，偏移 taskCount 时视口内容与 0 相同
  const trackItems = scrolling ? task.items.concat(task.items) : task.items
  const bubble = bubbleFor(mode, data, error, task)
  const stale = data !== null && Date.now() - data.fetchedAt > 90_000
  const dotClass = fetching
    ? 'wp-dot-fetching'
    : error !== null && data === null
      ? 'wp-dot-bad'
      : stale
        ? 'wp-dot-stale'
        : ''

  // 单行任务：序号 + 状态点 + 标题 + 百分比徽标，第二行真实进度条 + 阶段文案；点击行跳转会话页
  const renderTaskRow = (item: TaskItem, num: string, key: string): JSX.Element => {
    const p = item.progress
    const pct = p !== undefined && p.pct !== null ? p.pct : null
    const stageText = taskStageText(p)
    return h('div', {
      key,
      className: 'wp-task-row',
      title: '点击跳转到该会话',
      onClick: (event: MouseEvent): void => {
        event.stopPropagation()
        openTaskSession(item.id)
      },
    },
      h('div', { className: 'wp-task-main' },
        h('span', { className: 'wp-task-index' }, num),
        h('span', { className: 'wp-task-dot' }),
        h('span', { className: 'wp-task-name', title: item.title }, item.title),
        pct !== null && h('span', { className: 'wp-task-pct' }, pct + '%'),
      ),
      h('div', { className: 'wp-task-meta' },
        pct !== null && h('span', { className: 'wp-task-prog' }, h('span', { className: 'wp-task-prog-fill', style: { width: pct + '%' } })),
        h('span', { className: 'wp-task-stage', title: stageText }, stageText),
      ),
    )
  }

  return h('div', { className: 'wp-root', ref: rootRef },
    h('div',
      {
        className: `wp-pet${dragging ? ' wp-dragging' : ''}${bubble.cls === 'wp-low-balance' ? ' wp-low-balance' : ''}${bgLight ? ' wp-bg-light' : ' wp-bg-dark'}`,
        ref: petRef,
        style: {
          transform: `translate(${pos.x}px, ${pos.y}px)`,
          transition: dragging ? 'none' : 'transform 160ms ease-out',
        },
        title: '点击切换：余额 / 消费（今日 + 近 7 天）',
      },
      h('div', { className: `wp-bubble ${bubble.cls}` },
        h('div', { className: 'wp-bubble-title' },
          h('span', { className: `wp-dot ${dotClass}` }),
          h('span', null, bubble.title),
          mode === 0 && (
            h('span', {
              className: `wp-peak-badge${peak.active ? '' : ' wp-peak-off'}`,
              title: `北京时间 ${String(peak.hour).padStart(2, '0')}:00 · 高峰 09:00-12:00 / 14:00-18:00`,
            }, peak.active ? '⚡高峰' : '低谷')
          ),
          mode === 1 && data !== null && (
            h('span', { className: 'wp-source-badge', title: '消费金额按账户余额下降累计' }, '余额变化')
          ),
        ),
        h('div', { className: 'wp-bubble-sub' }, bubble.sub),
        mode === 1 && data !== null && (
          h('div', { className: 'wp-spend-panel' },
            h('div', { className: 'wp-spend-row' },
              h('span', { className: 'wp-spend-label' }, '今日'),
              h('span', { className: 'wp-spend-amt' }, formatMoney(data.spend.today.amount, data.balance?.currency ?? 'CNY')),
              h('span', { className: 'wp-spend-meta' }, data.spend.today.calls + ' 次调用'),
            ),
            h('div', { className: 'wp-spend-row' },
              h('span', { className: 'wp-spend-label' }, '近 7 天'),
              h('span', { className: 'wp-spend-amt' }, formatMoney(data.spend.days7.amount, data.balance?.currency ?? 'CNY')),
              h('span', { className: 'wp-spend-meta' }, data.spend.days7.calls + ' 次调用'),
            ),
          )
        ),
        mode === 2 && task.items.length > 0 && (
          h('div', { className: 'wp-task-panel' },
            scrolling
              ? h('div', { className: 'wp-task-scroll' },
                  h('div', {
                    className: 'wp-task-track',
                    title: '点击快进 · 每 5 秒自动滚动',
                    style: {
                      transform: `translateY(${-scrollOff * TASK_ROW_H}px)`,
                      transition: scrollSnapRef.current ? 'none' : 'transform 420ms ease',
                    },
                    onClick: () => {
                      setScrollOffset((o) => {
                        const n = task.items.length
                        if (o + 1 > n) return 0
                        return o + 1
                      })
                    },
                  },
                    trackItems.map((item, idx) =>
                      renderTaskRow(item, String((idx % taskCount) + 1).padStart(2, '0'), item.id + ':' + idx)
                    )
                  ),
                  h('div', { className: 'wp-task-page' }, taskCount + ' 个任务 · 自动滚动')
                )
              : h('div', { className: 'wp-task-list' },
                  task.items.map((item, idx) =>
                    renderTaskRow(item, String(idx + 1).padStart(2, '0'), item.id)
                  )
                ),
          )
        ),
        mode === 0 && (
          h('a', {
            className: 'wp-recharge-btn',
            href: 'https://platform.deepseek.com/top_up',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: '前往 DeepSeek 平台充值',
            onPointerDown: (e) => { e.stopPropagation() },
            onClick: (e) => { e.stopPropagation() },
          }, '充值 +')
        ),
      ),
      h('div', { className: 'wp-whale' }, h('img', {
        className: 'wp-whale-svg wp-whale-img',
        src: whaleChanUrl,
        alt: 'DeepSeek 鲸鱼娘',
        draggable: false,
      })),
      h('div', { className: 'wp-pager' },
        Array.from({ length: modeCount }, (_, i) =>
          h('span', { key: i, className: `wp-pager-dot${i === mode ? ' wp-pager-on' : ''}` })
        ),
      ),
    ),
  )
}
