import { listSessionLogs, type SessionLogMeta } from './sessions.ts'

export interface SessionProjection {
  index(home: string): ReadonlyMap<string, SessionLogMeta>
  invalidate(home?: string): void
  stats(): { homes: number; entries: number }
}

export interface SessionProjectionOptions {
  readonly ttlMs?: number
  readonly maxHomes?: number
  readonly maxEntries?: number
  readonly now?: () => number
  readonly scan?: (home: string) => readonly SessionLogMeta[]
}

interface IndexEntry {
  readonly expiresAt: number
  readonly index: ReadonlyMap<string, SessionLogMeta>
}

/** Shares filesystem enumeration between task routes and enforces deterministic cache budgets. */
export function createSessionProjection(options: SessionProjectionOptions = {}): SessionProjection {
  const ttlMs = options.ttlMs ?? 1_000
  const maxHomes = options.maxHomes ?? 4
  const maxEntries = options.maxEntries ?? 2_000
  const now = options.now ?? Date.now
  const scan = options.scan ?? listSessionLogs
  const homes = new Map<string, IndexEntry>()

  const trim = (): void => {
    let entries = [...homes.values()].reduce((sum, value) => sum + value.index.size, 0)
    while (homes.size > maxHomes || entries > maxEntries) {
      const first = homes.entries().next().value as [string, IndexEntry] | undefined
      if (first === undefined) break
      homes.delete(first[0])
      entries -= first[1].index.size
    }
  }

  return {
    index(home): ReadonlyMap<string, SessionLogMeta> {
      const timestamp = now()
      const cached = homes.get(home)
      if (cached !== undefined && timestamp < cached.expiresAt) {
        homes.delete(home)
        homes.set(home, cached)
        return cached.index
      }
      const logs = scan(home).slice(0, maxEntries)
      const index = new Map(logs.map((meta) => [meta.id, meta]))
      homes.delete(home)
      homes.set(home, { expiresAt: timestamp + ttlMs, index })
      trim()
      return index
    },
    invalidate(home): void {
      if (home === undefined) homes.clear()
      else homes.delete(home)
    },
    stats(): { homes: number; entries: number } {
      return {
        homes: homes.size,
        entries: [...homes.values()].reduce((sum, value) => sum + value.index.size, 0),
      }
    },
  }
}
