/**
 * PIXI renderer canvas 生命周期。
 *
 * PIXI 6 在 renderer.destroy() 时调用 WEBGL_lose_context.loseContext()。浏览器可能在
 * 同一 canvas 的下一次 getContext() 中返回该 lost context，因此任何新 renderer 都必须
 * 获得新的 canvas 节点；旧节点在 renderer 销毁后立即释放。
 */
export interface Live2DCanvasLease {
  canvas: HTMLCanvasElement
  release(): void
}

export function leaseLive2DCanvas(container: HTMLElement): Live2DCanvasLease {
  const canvas = document.createElement('canvas')
  canvas.className = 'wp-live2d-canvas'
  container.appendChild(canvas)

  let released = false
  return {
    canvas,
    release(): void {
      if (released) return
      released = true
      canvas.remove()
    },
  }
}
