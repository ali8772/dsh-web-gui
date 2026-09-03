/**
 * 大肥鲸桌面宠物组件：DeepSeek 品牌蓝的圆滚滚鲸鱼，悬浮于 GUI 角落。
 * - 每 60s 轮询 `/api/whale-pet/state`，实时余额 + 今日/近 7 天消费
 * - 点击鲸鱼循环切换显示：余额 → 今日消费 → 近 7 天消费
 * - 按住可拖拽，位置记忆在 localStorage
 * - 数据异常时鲸鱼变「沮丧」并显示错误气泡
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import whaleChanUrl from '../../assets/whale-chan.png'
import {
  importModelFromUrl,
  importModelFromZip,
  loadStoredModel,
  readConfig,
  removeStoredModel,
} from './live2d/ui.ts'
import type { Live2DHandle } from './live2d/core.ts'
import type { StoredModel } from './live2d/parse.ts'
import { ensureCubismCore } from './live2d/runtime.ts'

/** 动态加载 Live2D chunk（pixi + Cubism 渲染），避免运行时检查进入主 bundle。 */
interface Live2DChunk {
  mountLive2D(canvas: HTMLCanvasElement, stored: StoredModel, options?: { scale?: number }): Promise<Live2DHandle>
}
let live2dChunkPromise: Promise<Live2DChunk> | null = null
async function loadLive2DChunk(): Promise<Live2DChunk> {
  // pixi-live2d-display/cubism4 在模块顶层检查全局，因此顺序不能颠倒。
  await ensureCubismCore()
  if (live2dChunkPromise === null) {
    live2dChunkPromise = import('/dsh-whale-pet-live2d.js')
      .then((mod) => mod as unknown as Live2DChunk)
      .catch((cause) => {
        live2dChunkPromise = null
        throw cause
      })
  }
  return live2dChunkPromise
}

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
const SCALE_KEY = 'dsh-whale-pet:scale'
const PET_W = 170
const PET_H = 240 // 容纳放大后的鲸鱼娘（129×225 + 底部偏移）
const MIN_SCALE = 0.5
const MAX_SCALE = 2
const DEFAULT_SCALE = 1

/** 读取持久化的宠物大小（0.5–2），无值/无效值回退 1。 */
function loadPetScale(): number {
  try {
    const raw = localStorage.getItem(SCALE_KEY)
    if (raw === null) return DEFAULT_SCALE
    const value = Number(raw)
    if (!Number.isFinite(value)) return DEFAULT_SCALE
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
  } catch {
    return DEFAULT_SCALE
  }
}

const MODE_LABELS = ['余额与消费', '任务进度', 'OpenCode Go'] as const

// OpenCode Go 额度页：进入页面立即刷新，之后每 GO_REFRESH_MS 自动刷新
const GO_REFRESH_MS = 60_000
const GO_WINDOW_KEYS = ['rolling', 'weekly', 'monthly'] as const

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
  if (p.awaitingUser) {
    if (p.stage === 'tool' && p.tool === 'ask_user_question') return '等待用户回答…'
    return '等待用户操作…'
  }
  if (p.pct !== null) {
    if (p.current !== null && p.current !== '') return '正在：' + p.current
    return `已完成 ${p.done}/${p.total}`
  }
  if (p.stage === 'tool' && p.tool !== null) return '正在执行 ' + p.tool
  if (p.stage === 'thinking') return p.turn !== null ? `第 ${p.turn} 轮 · 思考中…` : '思考中…'
  return '准备中…'
}

/** 宿主按实际使用模型聚合的 token/费用明细。 */
export interface ModelUsageSummary {
  model: string
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  cost: number
  costUsd: number
}

// ---- OpenCode Go 套餐额度（宿主 /api/whale-pet/opencode-go） ----
export type OpenCodeGoWindowKey = 'rolling' | 'weekly' | 'monthly'

export interface OpenCodeGoWindow {
  readonly key: OpenCodeGoWindowKey
  readonly label: string
  readonly status: string
  readonly percent: number | null
  readonly remaining: number | null
  readonly resetsAt: number | null
}

export interface OpenCodeGoUsage {
  readonly configured: boolean
  readonly keySource: 'env' | 'auth' | null
  readonly error: string | null
  readonly fetchedAt: number
  readonly windows: Record<OpenCodeGoWindowKey, OpenCodeGoWindow>
}

/** 宿主返回的单会话 token/费用汇总。 */
export interface SessionSummary {
  id: string
  found: boolean
  model: string
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  cost: number
  costUsd: number
  models: ModelUsageSummary[]
  totalCalls: number
  totalInputTokens: number
  totalCacheReadTokens: number
  totalOutputTokens: number
  totalCost: number
  totalCostUsd: number
  totalModels: ModelUsageSummary[]
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
  /** 最近一次事件是否需要用户操作（ask_user_question / approval）。 */
  readonly awaitingUser: boolean
}
export interface TaskItem {
  id: string
  title: string
  /** DSH 会话父级；子代理指向发起它的主任务会话。 */
  parentId?: string
  progress?: TaskProgressInfo
}
export interface TaskInfo {
  running: boolean
  count: number
  items: readonly TaskItem[]
}
let taskCurrent: TaskInfo = { running: false, count: 0, items: [] }
const taskListeners = new Set<(t: TaskInfo) => void>()
/** 最近一个待展示的任务汇总；Widget 重挂载后仍可继续展示。 */
let summaryCurrent: SessionSummary | null = null
const summaryListeners = new Set<(summary: SessionSummary | null) => void>()

function publishSummary(summary: SessionSummary): void {
  summaryCurrent = summary
  for (const listener of summaryListeners) listener(summaryCurrent)
}

function dismissSummary(): void {
  summaryCurrent = null
  for (const listener of summaryListeners) listener(summaryCurrent)
}

function subscribeSummary(listener: (summary: SessionSummary | null) => void): () => void {
  summaryListeners.add(listener)
  listener(summaryCurrent)
  return () => { summaryListeners.delete(listener) }
}
/** 外部强制刷新任务进度（切到任务页时调用）。 */
let taskForceProgressRefresh: (() => void) | null = null
/** 点击任务行跳转会话页：由 attachTaskSource 注入 ctx.sessions.open。 */
let taskOpenSession: ((id: string) => void) | null = null
/** 当前唯一任务源的释放函数，防止插件重载后遗留轮询与重复完成通知。 */
let taskSourceDispose: (() => void) | null = null

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
  getSnapshot(): {
    current?: string
    byId: Record<string, { running: boolean; displayTitle: string; updatedAt: number; parentId?: string }>
  }
}

/** 收集工作区所有正在运行的会话（按最近更新排序，最多 10 条），并从宿主拉取真实进度。 */
export function attachTaskSource(
  list: TaskListLike | null | undefined,
  open?: ((id: string) => void) | null,
): () => void {
  taskSourceDispose?.()
  if (list === null || list === undefined) return () => {}
  taskOpenSession = typeof open === 'function' ? open : null
  let disposed = false
  // E2E/调试用：注入的假任务优先于真实数据
  let debugOverride: TaskInfo | null = null
  let progressById = new Map<string, TaskProgressInfo>()
  let lastProgressFetch = 0
  let runningIds = new Set<string>()
  /** 已报告完成的会话，避免重复弹窗。 */
  const reportedComplete = new Set<string>()
  /** 强制刷新标记：切到任务页时跳过节流立刻拉取。 */
  let forceProgressFetch = false

  /** 外部触发强制刷新（切到任务页时调用）。 */
  taskForceProgressRefresh = (): void => {
    forceProgressFetch = true
    lastProgressFetch = 0
  }

  /** POST 宿主 /api/whale-pet/tasks，把真实进度合并回当前任务列表。 */
  const fetchProgress = async (ids: readonly string[]): Promise<void> => {
    if (disposed) return
    const now = Date.now()
    if (ids.length === 0) return
    if (!forceProgressFetch && now - lastProgressFetch < 200) return
    forceProgressFetch = false
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
          awaitingUser?: boolean
        }>
      }
      if (disposed || body === null || body.ok !== true || !Array.isArray(body.tasks)) return
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
          awaitingUser: row.awaitingUser === true,
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

  /** 拉取单会话汇总并发布到持久化弹窗状态。 */
  const fetchSummary = async (id: string): Promise<void> => {
    if (disposed) return
    try {
      const response = await fetch('/api/whale-pet/task-summary', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
        cache: 'no-store',
      })
      if (!response.ok) return
      const body = (await response.json()) as { ok?: boolean; summary?: SessionSummary }
      if (disposed || body === null || body.ok !== true || body.summary === undefined) return
      if (body.summary.found) publishSummary(body.summary)
    } catch {
      // 汇总失败不影响任务进度
    }
  }

  const update = (): void => {
    if (disposed) return
    if (debugOverride !== null) {
      // 调试模式也跟踪 runningIds，以便检测任务完成。
      const newRunningIds = new Set<string>()
      for (const item of debugOverride.items) {
        newRunningIds.add(item.id)
        if (item.parentId !== undefined) newRunningIds.add(item.parentId)
      }
      // 检测从 running → 非 running 的会话：任务完成。
      for (const id of runningIds) {
        if (!newRunningIds.has(id) && !reportedComplete.has(id)) {
          reportedComplete.add(id)
          void fetchSummary(id)
        }
      }
      runningIds = newRunningIds
      for (const id of newRunningIds) reportedComplete.delete(id)
      taskCurrent = debugOverride
      for (const listener of taskListeners) listener(taskCurrent)
      return
    }
    try {
      const snap = list.getSnapshot()
      const byId = snap.byId
      const newRunningIds = new Set<string>()
      const candidates = Object.keys(byId)
        .filter((id) => byId[id]?.running === true)
        .sort((a, b) => (byId[b]?.updatedAt ?? 0) - (byId[a]?.updatedAt ?? 0))
        .slice(0, 10)
      for (const id of candidates) {
        newRunningIds.add(id)
        const parentId = byId[id]?.parentId
        if (parentId !== undefined && byId[parentId] !== undefined) newRunningIds.add(parentId)
      }
      // 检测从 running → 非 running 的会话：任务完成。
      for (const id of runningIds) {
        if (!newRunningIds.has(id) && !reportedComplete.has(id)) {
          reportedComplete.add(id)
          void fetchSummary(id)
        }
      }
      runningIds = newRunningIds
      for (const id of newRunningIds) reportedComplete.delete(id)
      const visibleIds = [...runningIds]
      const items = visibleIds.map((id) => ({
        id,
        title: byId[id]?.displayTitle ?? '',
        parentId: byId[id]?.parentId,
        progress: progressById.get(id),
      }))
      taskCurrent = { running: items.length > 0, count: items.length, items }
    } catch {
      taskCurrent = { running: false, count: 0, items: [] }
    }
    for (const listener of taskListeners) listener(taskCurrent)
    void fetchProgress(taskCurrent.items.map((item) => item.id))
  }
  update()
  const unsubscribe = list.subscribe(update)
  // 轮询兜底：订阅偶发不触发时仍能刷新任务状态
  const timer = window.setInterval(update, 1000)
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
        const enteringDebug = debugOverride === null
        debugOverride = { running: items.length > 0, count: items.length, items: [...items] }
        reportedComplete.clear()
        if (enteringDebug) {
          // 切换到调试数据不是“真实任务完成”；先建立基线，避免误弹真实会话汇总。
          runningIds = new Set()
          for (const item of items) {
            runningIds.add(item.id)
            if (item.parentId !== undefined) runningIds.add(item.parentId)
          }
          taskCurrent = debugOverride
          for (const listener of taskListeners) listener(taskCurrent)
        } else {
          update()
        }
      },
      clear: () => {
        debugOverride = null
        runningIds = new Set()
        reportedComplete.clear()
        update()
      },
    }
  } catch { /* ignore */ }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribe()
    window.clearInterval(timer)
    if (taskSourceDispose === dispose) taskSourceDispose = null
  }
  taskSourceDispose = dispose
  return dispose
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

function formatGoTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}


interface BubbleContent {
  title: string
  sub: string
  cls: string
}

function bubbleFor(
  mode: number,
  data: PetState | null,
  error: string | null,
  task: TaskInfo,
  go: OpenCodeGoUsage | null,
  goError: string | null,
  goFetching: boolean,
  goMode: number,
): BubbleContent {
  if (mode === goMode) {
    if (go === null) {
      return { title: 'OpenCode Go 额度', sub: goFetching ? '正在查询额度…' : '', cls: '' }
    }
    if (!go.configured) {
      return { title: 'OpenCode Go 额度', sub: goError ?? '未检测到 Go 登录', cls: '' }
    }
    if (go.error !== null) {
      return { title: 'OpenCode Go 额度', sub: go.error, cls: go.windows.rolling.percent === null ? 'wp-error' : '' }
    }
    const parts = GO_WINDOW_KEYS
      .map((key) => {
        const w = go.windows[key]
        return w.percent === null ? w.label : `${w.label} ${w.percent}%`
      })
      .join(' · ')
    return { title: 'OpenCode Go 额度', sub: parts, cls: '' }
  }
  if (data === null && error !== null) {
    return { title: '拿不到数据了', sub: '点我重试 · 每 60s 自动刷新', cls: 'wp-error' }
  }
  if (data === null) {
    return { title: '加载中…', sub: '正在询问深海', cls: '' }
  }
  const currency = data.balance?.currency ?? 'CNY'
  if (mode === 0) {
    // 余额 + 消费合并页：标题显示余额；今日/近 7 天消费只在下方面板展示一次。
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
  // mode === 1：任务进度页（仅在有任务时进入；无任务时本页是 OpenCode Go 额度）
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

function formatTokens(n: number): string {
  return Math.max(0, Math.trunc(n)).toLocaleString('zh-CN')
}

function modelUsageRows(scope: 'current' | 'total', rows: readonly ModelUsageSummary[]): JSX.Element | null {
  if (rows.length === 0) return null
  return h('div', { className: 'wp-summary-models', 'data-summary-model-scope': scope },
    h('div', { className: 'wp-summary-models-title' }, '按模型预估'),
    ...rows.map((row) => h('div', {
      key: row.model,
      className: 'wp-summary-model-row',
      'data-summary-model': row.model,
    },
      h('div', { className: 'wp-summary-model-main' },
        h('span', { className: 'wp-summary-model-name', title: row.model }, row.model),
        h('span', { className: 'wp-summary-model-cost' }, `¥${row.cost.toFixed(2)}`),
      ),
      h('div', { className: 'wp-summary-model-meta' },
        `${row.calls} 次 · ${formatTokens(row.inputTokens + row.cacheReadTokens + row.outputTokens)} tokens`,
      ),
    )),
  )
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
  const [summaryDialog, setSummaryDialog] = useState<SessionSummary | null>(null)
  const [goUsage, setGoUsage] = useState<OpenCodeGoUsage | null>(null)
  const [goError, setGoError] = useState<string | null>(null)
  const [goFetching, setGoFetching] = useState(false)
  const [petScale, setPetScale] = useState(() => loadPetScale())
  const petScaleRef = useRef(petScale)
  petScaleRef.current = petScale

  const updatePetScale = (value: number): void => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
    setPetScale(clamped)
    try {
      localStorage.setItem(SCALE_KEY, String(clamped))
    } catch {
      // 忽略存储失败
    }
  }

  // ---- Live2D（可选移植模型） ----
  const [live2d, setLive2d] = useState<{ phase: 'off' | 'loading' | 'ready' | 'error'; name?: string; error?: string }>({ phase: 'off' })
  const [live2dOpen, setLive2dOpen] = useState(false)
  const [live2dUrl, setLive2dUrl] = useState('')
  const [live2dExprCount, setLive2dExprCount] = useState(0)
  const live2dHandleRef = useRef<Live2DHandle | null>(null)
  const live2dCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const live2dFileRef = useRef<HTMLInputElement | null>(null)
  const live2dOperationRef = useRef(0)

  const setLive2dCanvas = (node: HTMLCanvasElement | null): void => {
    live2dCanvasRef.current = node
  }

  /** 用已持久化模型挂载/重挂 Live2D；只有当前 operation 才能接管画布。 */
  const mountStored = async (stored: StoredModel, operation: number): Promise<void> => {
    const canvas = live2dCanvasRef.current
    if (canvas === null || !canvas.isConnected) throw new Error('Live2D 画布尚未就绪，请稍后重试')
    const chunk = await loadLive2DChunk()
    if (operation !== live2dOperationRef.current) return
    const nextHandle = await chunk.mountLive2D(canvas, stored, { scale: petScaleRef.current })
    if (operation !== live2dOperationRef.current || !canvas.isConnected) {
      nextHandle.dispose()
      return
    }
    live2dHandleRef.current?.dispose()
    live2dHandleRef.current = nextHandle
    setLive2dExprCount(nextHandle.expressionCount())
  }

  /** 大小变化时同步提高渲染分辨率，Live2D 放大后仍保持清晰。 */
  useEffect(() => {
    live2dHandleRef.current?.setScale(petScale)
  }, [petScale])

  const handleZipImport = async (file: File): Promise<void> => {
    const operation = ++live2dOperationRef.current
    setLive2d({ phase: 'loading' })
    try {
      await loadLive2DChunk()
      const bytes = await file.arrayBuffer()
      const { config } = await importModelFromZip(bytes)
      const stored = await loadStoredModel()
      if (stored === null) throw new Error('导入后模型数据缺失')
      await mountStored(stored, operation)
      if (operation !== live2dOperationRef.current) return
      setLive2d({ phase: 'ready', name: config.name })
      setLive2dOpen(false)
    } catch (cause) {
      if (operation === live2dOperationRef.current) {
        setLive2d({ phase: 'error', error: cause instanceof Error ? cause.message : String(cause) })
      }
    }
  }

  const handleUrlImport = async (): Promise<void> => {
    const url = live2dUrl.trim()
    if (url === '') return
    const operation = ++live2dOperationRef.current
    setLive2d({ phase: 'loading' })
    try {
      await loadLive2DChunk()
      const { config } = await importModelFromUrl(url)
      const stored = await loadStoredModel()
      if (stored === null) throw new Error('导入后模型数据缺失')
      await mountStored(stored, operation)
      if (operation !== live2dOperationRef.current) return
      setLive2d({ phase: 'ready', name: config.name })
      setLive2dOpen(false)
    } catch (cause) {
      if (operation === live2dOperationRef.current) {
        setLive2d({ phase: 'error', error: cause instanceof Error ? cause.message : String(cause) })
      }
    }
  }

  const handleRemoveModel = async (): Promise<void> => {
    ++live2dOperationRef.current
    live2dHandleRef.current?.dispose()
    live2dHandleRef.current = null
    setLive2dExprCount(0)
    try {
      await removeStoredModel()
      setLive2d({ phase: 'off' })
      setLive2dOpen(false)
    } catch (cause) {
      setLive2d({ phase: 'error', error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  // 挂载时读取配置：已导入模型则自动恢复。
  useEffect(() => {
    const cfg = readConfig()
    if (cfg === null) return
    const operation = ++live2dOperationRef.current
    setLive2d({ phase: 'loading' })
    void (async () => {
      try {
        await loadLive2DChunk()
        const stored = await loadStoredModel()
        if (operation !== live2dOperationRef.current) return
        if (stored === null) {
          setLive2d({ phase: 'error', error: '已保存模型版本过旧，请重新导入' })
          return
        }
        await mountStored(stored, operation)
        if (operation === live2dOperationRef.current) setLive2d({ phase: 'ready', name: stored.config.name })
      } catch (cause) {
        if (operation === live2dOperationRef.current) {
          setLive2d({ phase: 'error', error: cause instanceof Error ? cause.message : String(cause) })
        }
      }
    })()
    return () => {
      ++live2dOperationRef.current
      live2dHandleRef.current?.dispose()
      live2dHandleRef.current = null
    }
    // 只在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    startedOnLive2D: boolean
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

  const refreshGo = async (): Promise<void> => {
    setGoFetching(true)
    try {
      const response = await fetch('/api/whale-pet/opencode-go', { cache: 'no-store', headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { ok?: boolean; usage?: OpenCodeGoUsage }
      if (body === null || typeof body !== 'object' || body.ok !== true || body.usage === undefined) throw new Error('bad payload')
      setGoUsage(body.usage)
      setGoError(null)
    } catch (cause) {
      setGoError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGoFetching(false)
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

  // 订阅任务完成汇总；订阅时会立即接收重挂载期间尚未关闭的弹窗。
  useEffect(() => subscribeSummary(setSummaryDialog), [])

  // 订阅当前任务状态（running + 会话标题）
  useEffect(() => subscribeTask(setTask), [])

  // 切到任务进度页时强制刷新进度，确保绿点颜色立刻更新。
  useEffect(() => {
    if (mode === 1) taskForceProgressRefresh?.()
  }, [mode])

  // 切到 OpenCode Go 额度页时立即刷新；常驻时每 60s 自动刷新。
  useEffect(() => {
    const goMode = task.running ? 2 : 1
    if (mode === goMode) void refreshGo()
    if (mode !== goMode) return
    const timer = window.setInterval(() => void refreshGo(), GO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [mode, task.running])

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

  // 无任务时模式总数回落；若当前页已不存在则回到余额页
  useEffect(() => {
    const count = (task.running ? 2 : 1) + 1
    if (mode >= count) setMode(0)
  }, [task.running, mode])

  // 任务进度页自动滚动：超过 5 条时每 5s 向上滚动一条；列表变化或离开任务页时复位
  useEffect(() => {
    setScrollOffset(0)
    if (mode !== 1 || task.items.length <= TASK_VIEW_SIZE) return
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
      } else if (!drag.startedOnLive2D) {
        // 普通鲸鱼单击 → 切换信息页；Live2D 单击留给模型交互动作。
        setMode((m) => {
          const next = (m + 1) % ((taskRef.current.running ? 2 : 1) + 1)
          if (next === 1) taskForceProgressRefresh?.()
          return next
        })
      }
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      // 充值按钮/进度条/任务行上的按下不进入拖拽（避免点击它们触发模式切换/拖拽）
      const target = event.target as HTMLElement | null
      if (target !== null && typeof target.closest === 'function'
        && target.closest('.wp-recharge-btn, .wp-task-prog, .wp-task-row, .wp-live2d-config') !== null) return
      const start = posRef.current
      dragState.current = {
        startX: event.clientX,
        startY: event.clientY,
        origX: start.x,
        origY: start.y,
        curX: 0,
        curY: 0,
        moved: false,
        startedOnLive2D: target?.closest('.wp-live2d-canvas') !== null,
      }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', finishDrag)
      window.addEventListener('pointercancel', finishDrag)
      if (target?.closest('.wp-live2d-canvas') === null) event.preventDefault()
    }

    pet.addEventListener('pointerdown', onPointerDown)
    return () => {
      pet.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])

  // 有任务时 3 页（余额+消费 / 任务进度 / OpenCode Go）；无任务时 2 页
  const modeCount = (task.running ? 2 : 1) + 1
  const goMode = modeCount - 1
  // 任务进度页：最多同时显示 5 行；parentId 将子代理归入主任务。
  const taskCount = task.items.length
  const itemById = new Map(task.items.map((item) => [item.id, item]))
  const childrenByParent = new Map<string, TaskItem[]>()
  for (const item of task.items) {
    if (item.parentId === undefined || item.parentId === item.id || !itemById.has(item.parentId)) continue
    const siblings = childrenByParent.get(item.parentId) ?? []
    siblings.push(item)
    childrenByParent.set(item.parentId, siblings)
  }
  const rootItems = task.items.filter((item) => item.parentId === undefined || item.parentId === item.id || !itemById.has(item.parentId))
  const scrollOff = Math.min(scrollOffset, taskCount)
  const scrolling = taskCount > TASK_VIEW_SIZE
  // 滚动时复制根任务树；family/children 使用 display:contents，因此轨道仍按每行 40px 平移。
  const trackRoots = scrolling ? rootItems.concat(rootItems) : rootItems
  const bubble = bubbleFor(mode, data, error, task, goUsage, goError, goFetching, goMode)
  const stale = data !== null && Date.now() - data.fetchedAt > 90_000
  const dotClass = fetching
    ? 'wp-dot-fetching'
    : error !== null && data === null
      ? 'wp-dot-bad'
      : stale
        ? 'wp-dot-stale'
        : ''

  // 单行任务：序号 + 状态点 + 标题 + 百分比徽标，第二行真实进度条 + 阶段文案；点击行跳转会话页
  const renderTaskRow = (item: TaskItem, num: string, key: string, child = false): JSX.Element => {
    const p = item.progress
    const pct = p !== undefined && p.pct !== null ? p.pct : null
    const stageText = taskStageText(p)
    const waiting = p !== undefined && p.awaitingUser === true
    return h('div', {
      key,
      className: `wp-task-row${child ? ' wp-task-child' : ''}${waiting ? ' wp-task-waiting' : ''}`,
      'data-task-id': item.id,
      title: waiting ? '需要你的操作 · 点击跳转到该会话' : (child ? '子代理 · 点击跳转到该会话' : '点击跳转到该会话'),
      onClick: (event: MouseEvent): void => {
        event.stopPropagation()
        openTaskSession(item.id)
      },
    },
      h('div', { className: 'wp-task-main' },
        h('span', { className: 'wp-task-index' }, num),
        h('span', { className: `wp-task-dot${waiting ? ' wp-task-dot-waiting' : ''}` }),
        h('span', { className: 'wp-task-name', title: item.title }, item.title),
        pct !== null && h('span', { className: 'wp-task-pct' }, pct + '%'),
      ),
      h('div', { className: 'wp-task-meta' },
        pct !== null && h('span', { className: 'wp-task-prog' }, h('span', { className: 'wp-task-prog-fill', style: { width: pct + '%' } })),
        h('span', { className: 'wp-task-stage', title: stageText }, stageText),
      ),
    )
  }

  /** 主任务 family：主行后紧跟它的子代理行，DOM 和视觉均体现从属关系。 */
  const renderTaskFamily = (item: TaskItem, num: string, key: string): JSX.Element => {
    const children = childrenByParent.get(item.id) ?? []
    return h('div', { key, className: 'wp-task-family', 'data-task-id': item.id },
      renderTaskRow(item, num, `${key}:root`),
      children.length > 0 && h('div', { className: 'wp-task-children' },
        children.map((child, index) => renderTaskRow(child, `↳${index + 1}`, `${key}:child:${child.id}`, true)),
      ),
    )
  }

  return h('div', { className: 'wp-root', ref: rootRef },
    h('div',
      {
        className: `wp-pet${dragging ? ' wp-dragging' : ''}${bubble.cls === 'wp-low-balance' ? ' wp-low-balance' : ''}${bgLight ? ' wp-bg-light' : ' wp-bg-dark'}${live2d.phase === 'ready' ? ' wp-live2d-active' : ''}`,
        ref: petRef,
        style: {
          transform: `translate(${pos.x}px, ${pos.y}px)`,
          transition: dragging ? 'none' : 'transform 160ms ease-out',
          ['--wp-scale' as string]: String(petScale),
        },
        title: '点击切换：余额与消费 / 任务进度 / OpenCode Go 额度',
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
        ),
        h('div', { className: 'wp-bubble-sub' }, bubble.sub),
        mode === 0 && data !== null && (
          h('div', { className: 'wp-spend-panel' },
            h('div', { className: 'wp-spend-caption' },
              '消费',
              h('span', { className: 'wp-spend-caption-note' }, '（按账户余额下降累计）'),
            ),
            h('div', { className: 'wp-spend-row' },
              h('span', { className: 'wp-spend-label' }, '今日消费'),
              h('span', { className: 'wp-spend-amt' }, formatMoney(data.spend.today.amount, data.balance?.currency ?? 'CNY')),
              h('span', { className: 'wp-spend-meta' }, data.spend.today.calls + ' 次调用'),
            ),
            h('div', { className: 'wp-spend-row' },
              h('span', { className: 'wp-spend-label' }, '近 7 天消费'),
              h('span', { className: 'wp-spend-amt' }, formatMoney(data.spend.days7.amount, data.balance?.currency ?? 'CNY')),
              h('span', { className: 'wp-spend-meta' }, data.spend.days7.calls + ' 次调用'),
            ),
          )
        ),
        mode === 1 && task.items.length > 0 && (
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
                    trackRoots.map((item, idx) =>
                      renderTaskFamily(item, String((idx % rootItems.length) + 1).padStart(2, '0'), item.id + ':' + idx)
                    )
                  ),
                  h('div', { className: 'wp-task-page' }, taskCount + ' 个任务 · 自动滚动')
                )
              : h('div', { className: 'wp-task-list' },
                  rootItems.map((item, idx) =>
                    renderTaskFamily(item, String(idx + 1).padStart(2, '0'), item.id)
                  )
                ),
          )
        ),
        mode === goMode && (
          h('div', { className: 'wp-go-panel', 'data-go-panel': 'true' },
            goUsage === null
              ? h('div', { className: 'wp-go-hint' }, goFetching ? '正在查询 OpenCode Go 额度…' : '')
              : !goUsage.configured
                ? h('div', { className: 'wp-go-hint' },
                    '未检测到 OpenCode Go 登录。\n请用 opencode 登录并开通 Go 套餐，或设置 OPENCODE_GO_API_KEY 环境变量。',
                  )
                : goUsage.windows.rolling.percent === null
                  ? h('div', { className: 'wp-go-hint wp-error' }, '额度查询失败：' + (goUsage.error ?? '未知错误'))
                  : GO_WINDOW_KEYS.map((key) => {
                      const w = goUsage.windows[key]
                      return h('div', {
                        key: w.key,
                        className: 'wp-go-row',
                        'data-go-window': w.key,
                      },
                        h('div', { className: 'wp-go-main' },
                          h('span', { className: 'wp-go-label' }, w.label),
                          h('span', { className: 'wp-go-used' }, `已用 ${w.percent}%`),
                          h('span', { className: 'wp-go-remaining' }, `剩余 ${w.remaining}%`),
                        ),
                        h('div', { className: 'wp-go-bar' },
                          h('span', { className: 'wp-go-fill', style: { width: `${w.percent}%` } }),
                        ),
                        h('div', { className: 'wp-go-meta' },
                          w.status !== '' && w.status !== 'ok' && h('span', { className: 'wp-go-status' }, w.status),
                          w.resetsAt !== null && h('span', { className: 'wp-go-reset' }, '重置 ' + formatGoTime(w.resetsAt)),
                        ),
                      )
                    }),
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
      h('div', { className: 'wp-whale' },
        h('div', { className: 'wp-whale-live2d' },
          h('canvas', { ref: setLive2dCanvas, className: 'wp-live2d-canvas' }),
        ),
        h('img', {
          className: 'wp-whale-svg wp-whale-img',
          src: whaleChanUrl,
          alt: 'DeepSeek 鲸鱼娘',
          draggable: false,
        }),
      ),
      h('button', {
        className: 'wp-live2d-config',
        type: 'button',
        title: '导入 / 管理 Live2D 模型',
        'aria-label': '打开 Live2D 模型设置',
        onPointerDown: (e) => { e.stopPropagation() },
        onClick: (e) => {
          e.stopPropagation()
          setLive2dOpen(true)
        },
      }, '⚙️'),
      h('div', { className: 'wp-pager' },
        Array.from({ length: modeCount }, (_, i) =>
          h('span', { key: i, className: `wp-pager-dot${i === mode ? ' wp-pager-on' : ''}` })
        ),
      ),
    ),
    summaryDialog !== null && createPortal(
      h('div', {
        className: 'wp-summary-backdrop',
        onClick: dismissSummary,
      },
        h('div', { className: 'wp-summary-dialog', onClick: (e): void => e.stopPropagation() },
          h('div', { className: 'wp-summary-header' },
            h('span', { className: 'wp-summary-title' }, '任务完成'),
            h('button', {
              className: 'wp-summary-close',
              type: 'button',
              title: '关闭',
              'aria-label': '关闭任务完成对话框',
              onClick: dismissSummary,
            }, '×'),
          ),
          h('div', { className: 'wp-summary-body' },
            h('div', { className: 'wp-summary-row' },
              h('span', { className: 'wp-summary-label' }, '最近模型'),
              h('span', { className: 'wp-summary-value' }, summaryDialog.model),
            ),
            h('div', { className: 'wp-summary-section', 'data-summary-scope': 'current' }, '本次对话消耗量'),
            h('div', { className: 'wp-summary-stats', 'data-summary-scope': 'current' },
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '请求次数'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'calls' }, summaryDialog.calls + ' 次'),
              ),
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '输入（未缓存）'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'input' }, formatTokens(summaryDialog.inputTokens)),
              ),
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '输入（缓存命中）'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'cache-read' }, formatTokens(summaryDialog.cacheReadTokens)),
              ),
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '输出'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'output' }, formatTokens(summaryDialog.outputTokens)),
              ),
              h('div', { className: 'wp-summary-row wp-summary-token-total' },
                h('span', { className: 'wp-summary-label' }, 'Token 合计'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'tokens' }, formatTokens(summaryDialog.inputTokens + summaryDialog.cacheReadTokens + summaryDialog.outputTokens)),
              ),
              h('div', { className: 'wp-summary-row wp-summary-subtotal' },
                h('span', { className: 'wp-summary-label' }, '本次费用（预估）'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'cost' }, `¥${summaryDialog.cost.toFixed(2)}`),
              ),
              modelUsageRows('current', summaryDialog.models),
            ),
            h('div', { className: 'wp-summary-section', 'data-summary-scope': 'total' }, '对话总消耗量'),
            h('div', { className: 'wp-summary-stats', 'data-summary-scope': 'total' },
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '请求次数'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'calls' }, summaryDialog.totalCalls + ' 次'),
              ),
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '输入（未缓存）'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'input' }, formatTokens(summaryDialog.totalInputTokens)),
              ),
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '输入（缓存命中）'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'cache-read' }, formatTokens(summaryDialog.totalCacheReadTokens)),
              ),
              h('div', { className: 'wp-summary-row' },
                h('span', { className: 'wp-summary-label' }, '输出'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'output' }, formatTokens(summaryDialog.totalOutputTokens)),
              ),
              h('div', { className: 'wp-summary-row wp-summary-token-total' },
                h('span', { className: 'wp-summary-label' }, 'Token 合计'),
                h('span', { className: 'wp-summary-value', 'data-summary-field': 'tokens' }, formatTokens(summaryDialog.totalInputTokens + summaryDialog.totalCacheReadTokens + summaryDialog.totalOutputTokens)),
              ),
              modelUsageRows('total', summaryDialog.totalModels),
            ),
            h('div', { className: 'wp-summary-row wp-summary-total' },
              h('span', { className: 'wp-summary-label' }, '对话总费用（预估）'),
              h('span', { className: 'wp-summary-value', 'data-summary-field': 'cost' }, `¥${summaryDialog.totalCost.toFixed(2)}`),
            ),
            h('div', { className: 'wp-summary-note' }, '按 DeepSeek 官方价格估算，实际以账单为准'),
          ),
        ),
      ),
      document.body,
    ),
    live2dOpen && createPortal(
      h('div', {
        className: 'wp-live2d-backdrop',
        onClick: () => setLive2dOpen(false),
      },
        h('div', { className: 'wp-live2d-dialog', onClick: (e): void => e.stopPropagation() },
          h('div', { className: 'wp-live2d-header' },
            h('span', { className: 'wp-live2d-title' }, 'Live2D 模型'),
            h('button', {
              className: 'wp-live2d-close',
              type: 'button',
              title: '关闭',
              'aria-label': '关闭 Live2D 设置',
              onClick: () => setLive2dOpen(false),
            }, '×'),
          ),
          h('div', { className: 'wp-live2d-body' },
            h('div', { className: 'wp-live2d-status', 'data-live2d-status': live2d.phase },
              live2d.phase === 'off' && '当前使用默认鲸鱼娘（未导入 Live2D）',
              live2d.phase === 'loading' && '正在加载模型…',
              live2d.phase === 'ready' && `已启用：${live2d.name ?? '模型'}`,
              live2d.phase === 'error' && `加载失败：${live2d.error ?? '未知错误'}`,
            ),
            h('div', { className: 'wp-live2d-section' },
              h('div', { className: 'wp-live2d-label' }, '导入 ZIP（.zip，含 model3.json 与资源）'),
              h('input', {
                ref: live2dFileRef,
                type: 'file',
                accept: '.zip,application/zip',
                className: 'wp-live2d-file',
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                  const file = e.target.files?.[0]
                  if (file !== undefined && file !== null) void handleZipImport(file)
                  e.target.value = ''
                },
              }),
            ),
            h('div', { className: 'wp-live2d-section' },
              h('div', { className: 'wp-live2d-label' }, '或从 URL 导入（.model3.json，服务器需允许 CORS）'),
              h('div', { className: 'wp-live2d-urlrow' },
                h('input', {
                  className: 'wp-live2d-url',
                  type: 'url',
                  placeholder: 'https://…/xxx.model3.json',
                  value: live2dUrl,
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => setLive2dUrl(e.target.value),
                }),
                h('button', {
                  className: 'wp-live2d-action',
                  type: 'button',
                  disabled: live2dUrl.trim() === '' || live2d.phase === 'loading',
                  onClick: () => void handleUrlImport(),
                }, '导入'),
              ),
            ),
            live2d.phase === 'ready' && (
              h('div', { className: 'wp-live2d-section' },
                h('div', { className: 'wp-live2d-label' }, '互动：移动鼠标可控制视线，点击模型会播放命中动作'),
                h('div', { className: 'wp-live2d-controls' },
                  h('button', {
                    className: 'wp-live2d-action',
                    type: 'button',
                    onClick: () => void live2dHandleRef.current?.playMotion(),
                  }, '播放动作'),
                  h('button', {
                    className: 'wp-live2d-action wp-live2d-secondary',
                    type: 'button',
                    disabled: live2dExprCount === 0,
                    title: live2dExprCount === 0 ? '当前模型未定义表情' : '随机切换一个表情',
                    onClick: () => void live2dHandleRef.current?.setExpression(),
                  }, '随机表情'),
                ),
                live2dExprCount === 0 && (
                  h('div', { className: 'wp-live2d-hint' }, '当前模型未定义表情，随机表情不可用')
                ),
              )
            ),
            h('div', { className: 'wp-live2d-section' },
              h('div', { className: 'wp-live2d-label' }, `宠物大小（当前 ${Math.round(petScale * 100)}%）`),
              h('div', { className: 'wp-live2d-scalerow' },
                h('input', {
                  className: 'wp-live2d-scale',
                  type: 'range',
                  min: '0.5',
                  max: '2',
                  step: '0.05',
                  value: String(petScale),
                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                    const next = Number(e.target.value)
                    if (Number.isFinite(next)) updatePetScale(next)
                  },
                }),
                h('button', {
                  className: 'wp-live2d-action wp-live2d-secondary',
                  type: 'button',
                  disabled: Math.abs(petScale - 1) < 0.0001,
                  onClick: () => updatePetScale(1),
                }, '恢复默认'),
              ),
              h('div', { className: 'wp-live2d-hint' }, '仅调整宠物模型大小，不改变气泡与对话框'),
            ),
            live2d.phase !== 'off' && (
              h('div', { className: 'wp-live2d-section' },
                h('button', {
                  className: 'wp-live2d-remove',
                  type: 'button',
                  onClick: () => void handleRemoveModel(),
                }, '移除模型，恢复默认鲸鱼娘'),
              )
            ),
          ),
        ),
      ),
      document.body,
    ),
  )
}
