/**
 * Live2D 渲染层（仅动态浏览器 chunk）。
 * 主 bundle 必须先通过 runtime.ts 加载本地 Cubism Core，再执行本模块。
 */

import { Application, Ticker } from 'pixi.js'
import { Cubism4ModelSettings, Live2DModel, MotionPreloadStrategy, MotionPriority } from 'pixi-live2d-display/cubism4'

import { StoredModel } from './parse'

/** 渲染后备存储分辨率上限：129×225 画布下约 516×900，足够 200% 缩放仍清晰。 */
const MAX_RENDER_RESOLUTION = 4

export interface MountOptions {
  /** 宠物显示大小（0.5–2）；渲染分辨率随其同步提升，避免放大后模糊。 */
  scale?: number
}

export interface Live2DHandle {
  dispose(): void
  playMotion(group?: string, index?: number): Promise<boolean>
  setExpression(id?: string | number): Promise<boolean>
  /** 更新显示大小：同步提高渲染分辨率，保持模型清晰度。 */
  setScale(scale: number): void
  /** 当前模型定义的表情数量；0 表示「随机表情」不可用。 */
  expressionCount(): number
}

function mimeFor(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  return 'application/octet-stream'
}

function motionGroups(model: Live2DModel): Array<[string, number]> {
  const definitions = model.internalModel.motionManager?.definitions
  if (definitions === null || typeof definitions !== 'object') return []
  return Object.entries(definitions)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0)
    .map(([group, motions]) => [group, motions.length])
}

/** 由显示大小推导渲染分辨率：dpr × scale，按"最大清晰度"加载无硬封顶。
 * 桌面 dpr 1–3、scale 0.5–2 时后备像素 64–774，远低于 GPU 纹理上限。 */
function renderResolution(scale: number): number {
  const dpr = Math.max(window.devicePixelRatio || 1, 1)
  return dpr * scale
}

/**
 * 挂载 Live2D：
 * - ModelSettings.resolveURL 直接返回对象 URL，绕过 PIXI 6 对 blob: 的旧解析；
 * - 鼠标移动驱动视线/头部 focus；
 * - 点击命中区域优先触发同名动作，再回退 TapBody/任意非 Idle 动作；
 * - 每 25 秒随机轻动作，模型自身同时提供眨眼、呼吸、物理效果。
 */
export async function mountLive2D(
  canvas: HTMLCanvasElement,
  stored: StoredModel,
  options: MountOptions = {},
): Promise<Live2DHandle> {
  Live2DModel.registerTicker(Ticker)
  const app = new Application({
    view: canvas,
    antialias: true,
    autoDensity: true,
    backgroundAlpha: 0,
    resizeTo: canvas.parentElement ?? canvas,
    resolution: renderResolution(options.scale ?? 1),
  })

  const settingsJson = structuredClone(stored.modelJson) as Record<string, unknown>
  // ModelSettings 要求 url 字段；实际资源解析由下方 resolveURL 覆盖。
  settingsJson.url = `https://dsh-whale-pet.invalid/${encodeURIComponent(stored.config.name)}.model3.json`
  const settings = new Cubism4ModelSettings(settingsJson as never)
  const objectUrls = new Map<string, string>()
  settings.resolveURL = (path: string): string => {
    const normalized = path.replaceAll('\\', '/')
    const bytes = stored.files[normalized]
    if (bytes === undefined) throw new Error(`已导入模型缺少资源：${path}`)
    let objectUrl = objectUrls.get(normalized)
    if (objectUrl === undefined) {
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeFor(path) }))
      objectUrls.set(normalized, objectUrl)
    }
    return objectUrl
  }

  let model: Live2DModel | null = null
  let disposed = false
  let idleTimer = 0
  let resizeObserver: ResizeObserver | null = null

  const expressionCount = (): number => {
    const definitions = model?.internalModel.motionManager?.expressionManager?.definitions
    return Array.isArray(definitions) ? definitions.length : 0
  }

  /** 调整显示大小时同步提高渲染分辨率，避免 CSS 放大导致的位图模糊。 */
  const setScale = (scale: number): void => {
    if (disposed) return
    const resolution = renderResolution(scale)
    if (app.renderer.resolution === resolution) return
    app.renderer.resolution = resolution
    app.resize()
  }

  const fitModel = (): void => {
    if (model === null || disposed) return
    // 模型严格居中 canvas：不留 padding，避免视觉上偏上/偏下。
    const width = Math.max(app.screen.width, 1)
    const height = Math.max(app.screen.height, 1)
    const rawWidth = Math.max(model.internalModel.originalWidth, 1)
    const rawHeight = Math.max(model.internalModel.originalHeight, 1)
    const scale = Math.min(width / rawWidth, height / rawHeight)
    model.scale.set(scale)
    model.position.set(app.screen.width / 2, app.screen.height / 2)
  }

  const playMotion = async (group?: string, index?: number, force = false): Promise<boolean> => {
    if (model === null || disposed) return false
    const groups = motionGroups(model)
    let selected = group
    if (selected === undefined || !groups.some(([name]) => name === selected)) {
      const nonIdle = groups.filter(([name]) => name.toLowerCase() !== 'idle')
      const pool = nonIdle.length > 0 ? nonIdle : groups
      selected = pool[Math.floor(Math.random() * pool.length)]?.[0]
    }
    if (selected === undefined) return false
    const count = groups.find(([name]) => name === selected)?.[1] ?? 0
    const selectedIndex = index ?? Math.floor(Math.random() * count)
    try {
      const started = await model.motion(selected, selectedIndex, force ? MotionPriority.FORCE : undefined)
      if (started) {
        canvas.dataset.live2dMotionGroup = selected
        canvas.dataset.live2dMotionCount = String(Number(canvas.dataset.live2dMotionCount ?? '0') + 1)
      }
      return started
    } catch {
      return false
    }
  }

  const setExpression = async (id?: string | number): Promise<boolean> => {
    if (model === null || disposed) return false
    try {
      const applied = await model.expression(id)
      if (applied) {
        canvas.dataset.live2dExpressionApplied = String(Number(canvas.dataset.live2dExpressionApplied ?? '0') + 1)
      }
      return applied
    } catch {
      return false
    }
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (model === null || disposed) return
    const rect = canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) * app.screen.width / Math.max(rect.width, 1)
    const y = (event.clientY - rect.top) * app.screen.height / Math.max(rect.height, 1)
    model.focus(x, y)
    canvas.dataset.live2dFocus = `${x.toFixed(1)},${y.toFixed(1)}`
  }
  const onPointerLeave = (): void => model?.focus(app.screen.width / 2, app.screen.height / 2)
  const onPointerTap = (event: PointerEvent): void => {
    if (model === null || disposed) return
    const rect = canvas.getBoundingClientRect()
    const x = (event.clientX - rect.left) * app.screen.width / Math.max(rect.width, 1)
    const y = (event.clientY - rect.top) * app.screen.height / Math.max(rect.height, 1)
    const hits = model.hitTest(x, y)
    const matching = hits.find((name) => motionGroups(model!).some(([group]) => group === name))
    void playMotion(matching ?? (motionGroups(model).some(([group]) => group === 'TapBody') ? 'TapBody' : undefined), undefined, true)
    if (hits.some((name) => /head|face/iu.test(name))) void setExpression()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    window.clearInterval(idleTimer)
    resizeObserver?.disconnect()
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerleave', onPointerLeave)
    canvas.removeEventListener('click', onPointerTap)
    delete canvas.dataset.live2dReady
    delete canvas.dataset.live2dMotionGroup
    delete canvas.dataset.live2dMotionCount
    delete canvas.dataset.live2dFocus
    delete canvas.dataset.live2dExpressions
    delete canvas.dataset.live2dExpressionApplied
    if (model !== null) {
      model.removeAllListeners()
      model.destroy({ children: true, texture: true, baseTexture: true })
      model = null
    }
    app.destroy(false, { children: false })
    for (const objectUrl of objectUrls.values()) URL.revokeObjectURL(objectUrl)
    objectUrls.clear()
  }

  try {
    model = await Live2DModel.from(settings, {
      autoInteract: false,
      autoUpdate: true,
      motionPreload: MotionPreloadStrategy.IDLE,
    })
    model.anchor.set(0.5, 0.5)
    app.stage.addChild(model)
    fitModel()
    resizeObserver = new ResizeObserver(fitModel)
    resizeObserver.observe(canvas.parentElement ?? canvas)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerleave', onPointerLeave)
    canvas.addEventListener('click', onPointerTap)
    canvas.dataset.live2dReady = 'true'
    canvas.dataset.live2dMotionCount = '0'
    canvas.dataset.live2dExpressions = String(expressionCount())
    canvas.dataset.live2dExpressionApplied = '0'

    const idleGroup = motionGroups(model).find(([group]) => group.toLowerCase() === 'idle')?.[0]
    if (idleGroup !== undefined) void playMotion(idleGroup)
    idleTimer = window.setInterval(() => void playMotion(), 25_000)
  } catch (cause) {
    dispose()
    throw cause
  }

  return { dispose, playMotion, setExpression, setScale, expressionCount }
}
