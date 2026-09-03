/**
 * Cubism Core 启动器（不依赖 PIXI）：必须先于 `pixi-live2d-display/cubism4`
 * 动态 chunk 执行。运行时由插件宿主从本地路由提供，不依赖外部 CDN。
 */

export const LOCAL_CUBISM_CORE_URL = '/dsh-whale-pet-live2dcubismcore.min.js'
const SCRIPT_ATTR = 'data-dsh-whale-pet-cubism-core'

let corePromise: Promise<void> | null = null

function hasCubismCore(): boolean {
  const core = (window as unknown as { Live2DCubismCore?: { Version?: unknown } }).Live2DCubismCore
  return core !== undefined && core.Version !== undefined
}

/**
 * 确保本地 Cubism Core 已作为 classic script 执行完毕。
 * 多个调用共享同一 Promise；失败后清理 script 并允许再次尝试。
 */
export function ensureCubismCore(): Promise<void> {
  if (hasCubismCore()) return Promise.resolve()
  if (corePromise !== null) return corePromise

  corePromise = new Promise<void>((resolve, reject) => {
    const previous = document.querySelector<HTMLScriptElement>(`script[${SCRIPT_ATTR}]`)
    previous?.remove()

    const script = document.createElement('script')
    script.src = LOCAL_CUBISM_CORE_URL
    script.async = true
    script.setAttribute(SCRIPT_ATTR, 'true')
    script.onload = () => {
      if (hasCubismCore()) {
        resolve()
      } else {
        reject(new Error('本地 Cubism Core 已加载，但运行时未初始化'))
      }
    }
    script.onerror = () => reject(new Error('无法加载本地 Cubism Core 运行环境'))
    document.head.appendChild(script)
  }).catch((cause) => {
    document.querySelector<HTMLScriptElement>(`script[${SCRIPT_ATTR}]`)?.remove()
    corePromise = null
    throw cause
  })

  return corePromise
}

/** 仅供诊断/E2E：确认本地 Core 全局已准备好。 */
export function cubismCoreReady(): boolean {
  return hasCubismCore()
}
