import type { StoredModel } from './parse.ts'

export const LIVE2D_MODEL_SCHEMA_VERSION = 1

export interface Live2DRecord {
  readonly schemaVersion: 1
  readonly config: StoredModel['config']
  readonly modelJson: unknown
  readonly rootJsonPath: string
  readonly files: Record<string, ArrayBuffer>
}

export interface Live2DRecordStore {
  read(): Promise<Live2DRecord | undefined>
  write(record: Live2DRecord): Promise<void>
  clear(): Promise<void>
}

export interface Live2DRepository {
  config(): Promise<StoredModel['config'] | null>
  load(): Promise<StoredModel | null>
  save(model: StoredModel): Promise<void>
  remove(): Promise<void>
}

function recordFromModel(model: StoredModel): Live2DRecord {
  const files: Record<string, ArrayBuffer> = {}
  for (const [path, bytes] of Object.entries(model.files)) {
    files[path] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
  return {
    schemaVersion: LIVE2D_MODEL_SCHEMA_VERSION,
    config: model.config,
    modelJson: model.modelJson,
    rootJsonPath: model.rootJsonPath,
    files,
  }
}

function modelFromRecord(record: Live2DRecord | undefined): StoredModel | null {
  if (
    record === undefined
    || record.schemaVersion !== LIVE2D_MODEL_SCHEMA_VERSION
    || record.config === null
    || typeof record.config !== 'object'
    || typeof record.rootJsonPath !== 'string'
    || record.rootJsonPath.length === 0
    || record.modelJson === null
    || typeof record.modelJson !== 'object'
    || record.files === null
    || typeof record.files !== 'object'
    || Array.isArray(record.files)
  ) return null
  const files: Record<string, Uint8Array> = {}
  for (const [path, bytes] of Object.entries(record.files)) {
    if (path.length === 0 || !(bytes instanceof ArrayBuffer)) return null
    files[path] = new Uint8Array(bytes)
  }
  return {
    config: record.config,
    modelJson: record.modelJson,
    rootJsonPath: record.rootJsonPath,
    files,
  }
}

/** Owns the single durable active-model record; no secondary marker can diverge. */
export function createLive2DRepository(store: Live2DRecordStore): Live2DRepository {
  return {
    async config() { return (await this.load())?.config ?? null },
    async load() { return modelFromRecord(await store.read()) },
    async save(model) { await store.write(recordFromModel(model)) },
    async remove() { await store.clear() },
  }
}
