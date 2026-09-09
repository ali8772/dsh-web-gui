/**
 * Live2D 单活动记录的持久化串行器。
 *
 * 模型下载/ZIP 解析可以并行，但 renderer 切换与 IndexedDB put/delete 必须通过同一
 * 队列，避免较慢的旧导入覆盖 active 记录，或在“移除模型”后把模型写回来。
 */
export interface Live2DMutationQueue {
  run<T>(mutation: () => Promise<T>): Promise<T>
}

export function createLive2DMutationQueue(): Live2DMutationQueue {
  let tail: Promise<void> = Promise.resolve()

  return {
    run<T>(mutation: () => Promise<T>): Promise<T> {
      const result = tail.then(mutation, mutation)
      // 某次失败不能让后续删除/提交跳过；tail 只表达“已结束”。
      tail = result.then(() => undefined, () => undefined)
      return result
    },
  }
}

/** 删除先持久化，成功且仍为最新操作时才切换回默认 renderer。 */
export async function removeLive2DIfCurrent(
  queue: Live2DMutationQueue,
  isCurrent: () => boolean,
  remove: () => Promise<void>,
  commit: () => void,
): Promise<boolean> {
  return queue.run(async () => {
    if (!isCurrent()) return false
    await remove()
    if (!isCurrent()) return false
    commit()
    return true
  })
}

export interface Live2DMutationStorage<T> {
  load(): Promise<T | null>
  save(value: T): Promise<void>
  remove(): Promise<void>
}

/** 新 renderer 先独立挂载；只有 durable commit 成功且操作仍最新时才切换。 */
export interface StagedLive2DReplacement {
  commit(): void
  discard(): void
}

/**
 * 串行、可回滚地提交并激活模型。
 *
 * 如果新操作在 stage/save 的 await 期间启动，则丢弃新 renderer，并在需要时恢复提交
 * 前的 durable snapshot。随后队列中的最新导入/移除接管，最终状态保持确定。
 */
export async function replaceLive2DIfCurrent<T>(
  queue: Live2DMutationQueue,
  isCurrent: () => boolean,
  next: T,
  storage: Live2DMutationStorage<T>,
  stage: () => Promise<StagedLive2DReplacement>,
): Promise<boolean> {
  return queue.run(async () => {
    if (!isCurrent()) return false
    const previous = await storage.load()
    if (!isCurrent()) return false

    let staged: StagedLive2DReplacement | null = null
    let saveAttempted = false

    const restoreDurableState = async (): Promise<void> => {
      if (!saveAttempted) return
      if (previous === null) await storage.remove()
      else await storage.save(previous)
      saveAttempted = false
    }

    const discard = (): void => {
      if (staged === null) return
      staged.discard()
      staged = null
    }

    try {
      staged = await stage()
      if (!isCurrent()) {
        discard()
        return false
      }

      saveAttempted = true
      await storage.save(next)
      if (!isCurrent()) {
        discard()
        await restoreDurableState()
        return false
      }

      staged.commit()
      staged = null
      saveAttempted = false
      return true
    } catch (cause) {
      discard()
      try {
        await restoreDurableState()
      } catch (rollbackCause) {
        throw new AggregateError([cause, rollbackCause], 'Live2D 模型提交失败，且无法恢复上一模型')
      }
      throw cause
    }
  })
}
