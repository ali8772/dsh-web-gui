/**
 * DSH 会话任务进度：按会话日志回放真实进度信号 ——
 *  - `todo/write`：agent 自维护的任务清单（pending/in_progress/completed），
 *    取最新一次快照得到 完成数/总数/当前正在做 ；
 *  - `tool/call` / `step/start` / `turn/start`：当前轮次、步骤与正在执行的工具。
 *
 * 性能：会话日志按 zstd frame 追加写入，这里以「帧游标」增量解析 —— 首次
 * 全量回放一次，之后只解压新增帧，轮询开销极小。未变化（mtime+size 相同）
 * 时只做 stat，完全不读文件。
 */

import { readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import {
  fileRevision,
  scanZstdFrames,
  type SessionLogMeta,
} from './sessions.ts'

/** 客户端可见的单会话进度快照。 */
export interface TaskProgress {
  readonly id: string
  readonly found: boolean
  /** 最新 todo/write 中的任务总数（0 = 该会话未使用 todo 清单）。 */
  readonly totalTodos: number
  readonly doneTodos: number
  /** 当前 in_progress 的 todo 内容（agent 正在做的事）。 */
  readonly currentTodo: string | null
  /** 完成百分比 0-100；无 todo 清单时为 null。 */
  readonly pct: number | null
  readonly stage: 'tool' | 'thinking' | 'idle'
  /** stage='tool' 时最近一次工具名。 */
  readonly tool: string | null
  readonly turn: number | null
  readonly step: number | null
  /** 日志最后修改时间（ms）。 */
  readonly updatedAt: number | null
}

interface Cursor {
  kind: 'zstd' | 'plain'
  rev: string
  /** 已处理到的完整 frame 数 / 已处理文本字节数。 */
  processedFrames: number
  processedBytes: number
  todoTotal: number
  todoDone: number
  todoCurrent: string | null
  lastTool: { turn: number; step: number; name: string } | null
  lastStep: { turn: number; step: number } | null
  lastTurn: number | null
  lastEventType: string | null
}

/** 我们关心的低流量事件类型；其余（chunk/reasoning 等）只更新 lastEventType。 */
const PARSE_TYPES = new Set([
  'todo/write',
  'tool/call',
  'step/start',
  'turn/start',
])

function freshCursor(kind: 'zstd' | 'plain'): Cursor {
  return {
    kind,
    rev: '',
    processedFrames: 0,
    processedBytes: 0,
    todoTotal: 0,
    todoDone: 0,
    todoCurrent: null,
    lastTool: null,
    lastStep: null,
    lastTurn: null,
    lastEventType: null,
  }
}

/** 回放一段日志文本，更新游标信号（行顺序即时间顺序）。 */
function processLogText(text: string, cursor: Cursor): void {
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const type = line[0] === '{' ? line.slice(0, 60).match(/^\{?"type":"([^"]+)"/)?.[1] : null
    if (type === undefined || type === null) continue
    cursor.lastEventType = type
    if (!PARSE_TYPES.has(type)) continue
    let event: { type?: string; data?: unknown; time?: unknown }
    try {
      event = JSON.parse(line) as { type?: string; data?: unknown; time?: unknown }
    } catch {
      continue
    }
    if (event.type !== type) continue
    const data = event.data as Record<string, unknown> | null | undefined
    if (type === 'todo/write') {
      const todos = Array.isArray(data?.todos) ? data.todos as Array<Record<string, unknown>> : []
      const done = todos.filter((t) => t.status === 'completed').length
      const current = todos.find((t) => t.status === 'in_progress')
      cursor.todoTotal = todos.length
      cursor.todoDone = done
      cursor.todoCurrent = typeof current?.content === 'string' ? current.content : null
    } else if (type === 'tool/call') {
      const turn = toInt(data?.turn)
      const step = toInt(data?.step)
      const name = typeof data?.name === 'string' ? data.name : null
      if (turn !== null && step !== null && name !== null) cursor.lastTool = { turn, step, name }
    } else if (type === 'step/start') {
      const turn = toInt(data?.turn)
      const step = toInt(data?.step)
      if (turn !== null && step !== null) cursor.lastStep = { turn, step }
      if (turn !== null) cursor.lastTurn = turn
    } else if (type === 'turn/start') {
      const turn = toInt(data?.turn)
      if (turn !== null) cursor.lastTurn = turn
    }
  }
}

function toInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** 增量刷新一个会话的游标；返回是否发生变化。 */
function refreshCursor(meta: SessionLogMeta, cursor: Cursor): boolean {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(meta.path)
  } catch {
    return false
  }
  const rev = `${stat.mtimeMs}\u0000${stat.size}`
  if (cursor.rev !== '' && cursor.rev === rev) return false
  let buffer: Buffer
  try {
    buffer = readFileSync(meta.path)
  } catch {
    return false
  }
  if (meta.path.endsWith('.zstd') && cursor.kind === 'zstd') {
    const frames = scanZstdFrames(buffer)
    if (frames.length < cursor.processedFrames) {
      // 日志被重写（罕见）：整段重放
      cursor.processedFrames = 0
      cursor.todoTotal = 0
      cursor.todoDone = 0
      cursor.todoCurrent = null
      cursor.lastTool = null
      cursor.lastStep = null
      cursor.lastTurn = null
      cursor.lastEventType = null
    }
    for (const frame of frames.slice(cursor.processedFrames)) {
      try {
        processLogText(zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'), cursor)
      } catch {
        // 单个 frame 损坏不阻塞
      }
    }
    cursor.processedFrames = frames.length
  } else if (!meta.path.endsWith('.zstd') && cursor.kind === 'plain') {
    const text = buffer.toString('utf8')
    const start = Math.min(cursor.processedBytes, text.length)
    if (start < text.length) {
      // 按完整行增量：丢弃可能被截断的半行
      const raw = text.slice(start)
      const nl = raw.lastIndexOf('\n')
      if (nl >= 0) {
        processLogText(raw.slice(0, nl + 1), cursor)
        cursor.processedBytes = start + nl + 1
      }
    }
  } else {
    // 文件格式变化：重置后整段重放
    const fresh = freshCursor(meta.path.endsWith('.zstd') ? 'zstd' : 'plain')
    Object.assign(cursor, fresh)
    return refreshCursor(meta, cursor)
  }
  cursor.rev = rev
  return true
}

const cursors = new Map<string, Cursor>()

/** 计算单个会话的进度快照（带增量游标缓存）。 */
export function progressForSession(logIndex: ReadonlyMap<string, SessionLogMeta>, id: string): TaskProgress {
  const meta = logIndex.get(id)
  if (meta === undefined) {
    cursors.delete(id)
    return { id, found: false, totalTodos: 0, doneTodos: 0, currentTodo: null, pct: null, stage: 'idle', tool: null, turn: null, step: null, updatedAt: null }
  }
  let cursor = cursors.get(id)
  if (cursor === undefined) {
    cursor = freshCursor(meta.path.endsWith('.zstd') ? 'zstd' : 'plain')
    cursors.set(id, cursor)
  }
  refreshCursor(meta, cursor)

  const pct = cursor.todoTotal > 0 ? Math.round((cursor.todoDone / cursor.todoTotal) * 100) : null
  const last = cursor.lastEventType
  const stage = last === 'tool/call' || last === 'tool-call-chunks'
    ? 'tool'
    : last !== null
      ? 'thinking'
      : 'idle'
  const tool = cursor.lastTool !== null ? cursor.lastTool.name : null
  const turn = cursor.lastTool !== null ? cursor.lastTool.turn : cursor.lastTurn
  const step = cursor.lastTool !== null ? cursor.lastTool.step : (cursor.lastStep !== null ? cursor.lastStep.step : null)
  let updatedAt: number | null = null
  try {
    updatedAt = statSync(meta.path).mtimeMs
  } catch {
    // ignore
  }
  return {
    id,
    found: true,
    totalTodos: cursor.todoTotal,
    doneTodos: cursor.todoDone,
    currentTodo: cursor.todoCurrent,
    pct,
    stage,
    tool,
    turn,
    step,
    updatedAt,
  }
}
