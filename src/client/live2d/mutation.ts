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

/** 删除模型资产；仅删除活动项时在 durable delete 后切换回默认 renderer。 */
export async function deleteLive2DIfCurrent(
  queue: Live2DMutationQueue,
  isCurrent: () => boolean,
  remove: () => Promise<{ readonly deleted: boolean; readonly wasActive: boolean }>,
  commitDefault: () => void,
): Promise<boolean> {
  return queue.run(async () => {
    if (!isCurrent()) return false
    const result = await remove()
    // Use the atomic durable result, not a stale UI snapshot. Once active deletion commits,
    // reflect default before any newer queued operation takes over.
    if (result.deleted && result.wasActive) commitDefault()
    return result.deleted
  })
}

/** 默认回退先持久化，成功且仍为最新操作时才切换 renderer。 */
export async function useDefaultLive2DIfCurrent(
  queue: Live2DMutationQueue,
  isCurrent: () => boolean,
  remove: () => Promise<void>,
  commit: () => void,
): Promise<boolean> {
  return queue.run(async () => {
    if (!isCurrent()) return false
    await remove()
    // A successful durable default must always be reflected by the current renderer before a
    // newer queued operation supersedes it.
    commit()
    return true
  })
}

export interface Live2DMutationStorage<T> {
  save(value: T): Promise<void>
}

export interface SavedLive2DSwitchStorage<T> {
  load(id: string): Promise<T | null>
  activate(id: string): Promise<boolean>
}

/** 新 renderer 先独立挂载；只有 durable commit 成功且操作仍最新时才切换。 */
export interface StagedLive2DReplacement {
  /** Must not throw; renderer adapters perform best-effort cleanup internally. */
  commit(): void
  /** Must not throw and may be called at most once. */
  discard(): void
}

/** 在已有模型之间切换；先加载并 stage renderer，成功后才更新 durable active/MRU。 */
export async function switchLive2DIfCurrent<T>(
  queue: Live2DMutationQueue,
  isCurrent: () => boolean,
  id: string,
  storage: SavedLive2DSwitchStorage<T>,
  stage: (model: T) => Promise<StagedLive2DReplacement>,
): Promise<boolean> {
  return queue.run(async () => {
    if (!isCurrent()) return false
    const model = await storage.load(id)
    if (model === null || !isCurrent()) return false

    let staged: StagedLive2DReplacement | null = null
    try {
      staged = await stage(model)
      if (!isCurrent()) {
        staged.discard()
        staged = null
        return false
      }
      const activated = await storage.activate(id)
      if (!activated) {
        staged.discard()
        staged = null
        return false
      }
      // As with import, a successful durable activation must be reflected by the renderer before
      // a newer queued operation supersedes it; stale compensation would corrupt the MRU state.
      staged.commit()
      staged = null
      return true
    } catch (cause) {
      staged?.discard()
      throw cause
    }
  })
}

/**
 * 串行、可回滚地提交并激活模型。
 *
 * stage 完成前过期则直接丢弃；事务性 durable save 失败时无需补偿，成功后则必须完成 renderer
 * commit，随后队列中的最新导入/默认回退接管。这样不会破坏 MRU 或丢失已淘汰的第六个模型。
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

    let staged: StagedLive2DReplacement | null = null
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

      // The library save is one IndexedDB transaction: rejection leaves it unchanged. Once it
      // succeeds this is a real commit; ordinary save/remove compensation would corrupt the MRU
      // and cannot resurrect an evicted sixth model.
      await storage.save(next)
      staged.commit()
      staged = null
      return true
    } catch (cause) {
      discard()
      throw cause
    }
  })
}
