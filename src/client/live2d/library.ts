import { createModelId, type Live2DConfig, type StoredModel } from './parse.ts'

export const LIVE2D_LIBRARY_SCHEMA_VERSION = 2
export const MAX_RECENT_LIVE2D_MODELS = 5
export const LIVE2D_LIBRARY_KEY = 'library'
export const LEGACY_ACTIVE_MODEL_KEY = 'active'
const MODEL_KEY_PREFIX = 'model:'

export interface Live2DModelSummary {
  readonly id: string
  readonly name: string
  readonly kind: Live2DConfig['kind']
  readonly importedAt: number
  readonly lastUsedAt: number
  readonly active: boolean
}

interface Live2DLibraryEntry {
  readonly id: string
  readonly lastUsedAt: number
  readonly config: Live2DConfig
}

export interface Live2DLibraryRecord {
  readonly schemaVersion: 2
  readonly activeModelId: string | null
  readonly models: readonly Live2DLibraryEntry[]
}

interface Live2DStoreChange<T> {
  readonly value: unknown
  readonly puts?: readonly { readonly key: string; readonly value: unknown }[]
  readonly deletes?: readonly string[]
  readonly result: T
}

export interface Live2DLibraryStore {
  read(key: string): Promise<unknown>
  readMany(keys: readonly string[]): Promise<readonly unknown[]>
  readRelated(key: string, relatedKey: (current: unknown) => string | null): Promise<readonly [unknown, unknown]>
  updateWithRelated<T>(key: string, relatedKey: string, change: (current: unknown, related: unknown) => Live2DStoreChange<T>): Promise<T>
  update<T>(key: string, change: (current: unknown) => Live2DStoreChange<T>): Promise<T>
}

export interface Live2DDeleteResult {
  readonly deleted: boolean
  readonly wasActive: boolean
}

export interface Live2DModelLibrary {
  list(): Promise<readonly Live2DModelSummary[]>
  load(): Promise<StoredModel | null>
  loadById(id: string): Promise<StoredModel | null>
  save(model: StoredModel): Promise<void>
  activate(id: string): Promise<boolean>
  useDefault(): Promise<void>
  delete(id: string): Promise<Live2DDeleteResult>
}

interface LibraryOptions {
  now?: () => number
  createId?: () => string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isConfig(value: unknown): value is Live2DConfig {
  return isObject(value)
    && (value.kind === 'zip' || value.kind === 'url')
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.importedAt === 'number'
    && Number.isFinite(value.importedAt)
    && (value.modelId === undefined || (typeof value.modelId === 'string' && value.modelId.length > 0))
}

function isStoredModel(value: unknown): value is StoredModel {
  if (!isObject(value) || !isConfig(value.config) || !isObject(value.files)) return false
  if (typeof value.rootJsonPath !== 'string' || value.rootJsonPath.length === 0 || !isObject(value.modelJson)) return false
  for (const [path, bytes] of Object.entries(value.files)) {
    if (path.length === 0 || !(bytes instanceof Uint8Array)) return false
  }
  return true
}

function isEntry(value: unknown): value is Live2DLibraryEntry {
  return isObject(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.lastUsedAt === 'number'
    && Number.isFinite(value.lastUsedAt)
    && isConfig(value.config)
}

function readLibrary(value: unknown): Live2DLibraryRecord | null {
  if (!isObject(value) || value.schemaVersion !== LIVE2D_LIBRARY_SCHEMA_VERSION || !Array.isArray(value.models)) return null
  if (value.activeModelId !== null && typeof value.activeModelId !== 'string') return null
  if (value.models.length > MAX_RECENT_LIVE2D_MODELS || !value.models.every(isEntry)) return null
  if (value.models.some((entry) => entry.config.modelId !== entry.id)) return null
  const ids = new Set(value.models.map((entry) => entry.id))
  if (ids.size !== value.models.length) return null
  return {
    schemaVersion: LIVE2D_LIBRARY_SCHEMA_VERSION,
    activeModelId: value.activeModelId !== null && ids.has(value.activeModelId) ? value.activeModelId : null,
    models: value.models,
  }
}

function modelFromLegacyRecord(value: unknown): StoredModel | null {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.files)) return null
  const files: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(value.files)) {
    if (path.length === 0 || !(bytes instanceof ArrayBuffer)) return null
    files[path] = new Uint8Array(bytes)
  }
  const model: unknown = {
    config: value.config,
    modelJson: value.modelJson,
    rootJsonPath: value.rootJsonPath,
    files,
  }
  return isStoredModel(model) ? model : null
}

function legacyModelId(model: StoredModel): string {
  return `legacy-${model.config.kind}-${model.config.importedAt}-${model.config.rootJsonPath ?? model.rootJsonPath}`
}

function modelKey(id: string): string {
  return `${MODEL_KEY_PREFIX}${id}`
}

function emptyLibrary(): Live2DLibraryRecord {
  return { schemaVersion: LIVE2D_LIBRARY_SCHEMA_VERSION, activeModelId: null, models: [] }
}

function summary(entry: Live2DLibraryEntry, activeModelId: string | null): Live2DModelSummary {
  return {
    id: entry.id,
    name: entry.config.name,
    kind: entry.config.kind,
    importedAt: entry.config.importedAt,
    lastUsedAt: entry.lastUsedAt,
    active: entry.id === activeModelId,
  }
}

/** Owns the bounded MRU manifest and separately stored model assets. */
export function createLive2DModelLibrary(store: Live2DLibraryStore, options: LibraryOptions = {}): Live2DModelLibrary {
  const now = options.now ?? Date.now
  const createId = options.createId ?? createModelId
  let migration: Promise<Live2DLibraryRecord> | null = null

  const read = async (): Promise<Live2DLibraryRecord> => {
    const current = readLibrary(await store.read(LIVE2D_LIBRARY_KEY))
    if (current !== null) return current
    if (migration !== null) return migration
    migration = store.updateWithRelated(LIVE2D_LIBRARY_KEY, LEGACY_ACTIVE_MODEL_KEY, (latest, legacy) => {
      const existing = readLibrary(latest)
      if (existing !== null) return { value: existing, result: existing }
      const legacyModel = modelFromLegacyRecord(legacy)
      if (legacyModel === null) {
        const empty = emptyLibrary()
        return { value: empty, deletes: [LEGACY_ACTIVE_MODEL_KEY], result: empty }
      }
      const id = legacyModelId(legacyModel)
      const stored: StoredModel = { ...legacyModel, config: { ...legacyModel.config, modelId: id } }
      const migrated: Live2DLibraryRecord = {
        schemaVersion: LIVE2D_LIBRARY_SCHEMA_VERSION,
        activeModelId: id,
        models: [{ id, lastUsedAt: now(), config: stored.config }],
      }
      return {
        value: migrated,
        puts: [{ key: modelKey(id), value: stored }],
        deletes: [LEGACY_ACTIVE_MODEL_KEY],
        result: migrated,
      }
    })
    try {
      return await migration
    } finally {
      migration = null
    }
  }

  const loadById = async (id: string): Promise<StoredModel | null> => {
    await read()
    const [manifestValue, model] = await store.readMany([LIVE2D_LIBRARY_KEY, modelKey(id)])
    const manifest = readLibrary(manifestValue)
    if (manifest === null || !manifest.models.some((entry) => entry.id === id)) return null
    return isStoredModel(model) && model.config.modelId === id ? model : null
  }

  return {
    async list() {
      const record = await read()
      return record.models.map((entry) => summary(entry, record.activeModelId))
    },
    async load() {
      await read()
      const [manifestValue, model] = await store.readRelated(LIVE2D_LIBRARY_KEY, (current) => {
        const manifest = readLibrary(current)
        return manifest?.activeModelId === null || manifest?.activeModelId === undefined
          ? null
          : modelKey(manifest.activeModelId)
      })
      const manifest = readLibrary(manifestValue)
      if (manifest?.activeModelId === null || manifest?.activeModelId === undefined) return null
      if (isStoredModel(model) && model.config.modelId === manifest.activeModelId) return model
      const brokenId = manifest.activeModelId
      await store.update(LIVE2D_LIBRARY_KEY, (current) => {
        const latest = readLibrary(current) ?? emptyLibrary()
        if (latest.activeModelId !== brokenId) return { value: latest, result: undefined }
        return {
          value: {
            ...latest,
            activeModelId: null,
            models: latest.models.filter((entry) => entry.id !== brokenId),
          },
          deletes: [modelKey(brokenId)],
          result: undefined,
        }
      })
      return null
    },
    loadById,
    async save(model) {
      await read()
      const id = typeof model.config.modelId === 'string' && model.config.modelId.length > 0
        ? model.config.modelId
        : createId()
      if (model.config.modelId !== id) model.config.modelId = id
      const stored: StoredModel = model
      await store.update(LIVE2D_LIBRARY_KEY, (current) => {
        const record = readLibrary(current) ?? emptyLibrary()
        const entry: Live2DLibraryEntry = { id, lastUsedAt: now(), config: stored.config }
        const models = [entry, ...record.models.filter((item) => item.id !== id)].slice(0, MAX_RECENT_LIVE2D_MODELS)
        const retained = new Set(models.map((item) => item.id))
        const evicted = record.models.filter((item) => !retained.has(item.id)).map((item) => modelKey(item.id))
        return {
          value: { schemaVersion: LIVE2D_LIBRARY_SCHEMA_VERSION, activeModelId: id, models },
          puts: [{ key: modelKey(id), value: stored }],
          deletes: evicted,
          result: undefined,
        }
      })
    },
    async activate(id) {
      await read()
      return store.update(LIVE2D_LIBRARY_KEY, (current) => {
        const record = readLibrary(current) ?? emptyLibrary()
        const existing = record.models.find((entry) => entry.id === id)
        if (existing === undefined) return { value: record, result: false }
        const entry = { ...existing, lastUsedAt: now() }
        return {
          value: {
            schemaVersion: LIVE2D_LIBRARY_SCHEMA_VERSION,
            activeModelId: id,
            models: [entry, ...record.models.filter((item) => item.id !== id)],
          },
          result: true,
        }
      })
    },
    async useDefault() {
      await read()
      await store.update(LIVE2D_LIBRARY_KEY, (current) => {
        const record = readLibrary(current) ?? emptyLibrary()
        return { value: { ...record, activeModelId: null }, result: undefined }
      })
    },
    async delete(id) {
      await read()
      return store.update(LIVE2D_LIBRARY_KEY, (current) => {
        const record = readLibrary(current) ?? emptyLibrary()
        const deleted = record.models.some((entry) => entry.id === id)
        const wasActive = deleted && record.activeModelId === id
        return {
          value: {
            ...record,
            activeModelId: wasActive ? null : record.activeModelId,
            models: record.models.filter((entry) => entry.id !== id),
          },
          deletes: deleted ? [modelKey(id)] : [],
          result: { deleted, wasActive },
        }
      })
    },
  }
}
