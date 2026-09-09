export interface PollingController {
  trigger(): Promise<void>
  pending(): Promise<void>
  dispose(): void
}

export interface PollingControllerOptions<T> {
  poll(signal: AbortSignal): Promise<T>
  commit(value: T): void
  fail?(error: unknown): void
  active?(): boolean
}

/** Owns one latest-wins request lane. Concurrent triggers share the active promise. */
export function createPollingController<T>(options: PollingControllerOptions<T>): PollingController {
  let disposed = false
  let generation = 0
  let active: { controller: AbortController; promise: Promise<void> } | null = null

  const trigger = (): Promise<void> => {
    if (disposed || options.active?.() === false) return Promise.resolve()
    if (active !== null) return active.promise
    const controller = new AbortController()
    const runGeneration = ++generation
    const lane = { controller, promise: Promise.resolve() }
    const promise = (async () => {
      try {
        const value = await options.poll(controller.signal)
        if (!disposed && runGeneration === generation && !controller.signal.aborted) options.commit(value)
      } catch (error) {
        if (!disposed && runGeneration === generation && !controller.signal.aborted) options.fail?.(error)
      } finally {
        if (active === lane) active = null
      }
    })()
    lane.promise = promise
    active = lane
    return promise
  }

  return {
    trigger,
    pending: () => active?.promise ?? Promise.resolve(),
    dispose(): void {
      if (disposed) return
      disposed = true
      generation += 1
      active?.controller.abort()
    },
  }
}
