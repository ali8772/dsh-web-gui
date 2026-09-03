/**
 * Live2D 导入与持久化层（无 PIXI 依赖）。
 * 模型资产只保存在当前浏览器的 IndexedDB；URL 导入下载后同样本地化。
 */

import {
  assetRefsFromModelJson,
  basename,
  findModelRootZip,
  materializeZipModel,
  StoredModel,
} from './parse'

const DB_NAME = 'dsh-whale-pet-live2d'
const STORE = 'models'
const RECORD_KEY = 'active'
const CONFIG_KEY = 'dsh-whale-pet:live2d'
const MODEL_SCHEMA_VERSION = 1

interface StoredRecord {
  schemaVersion: 1
  config: StoredModel['config']
  modelJson: unknown
  rootJsonPath: string
  files: Record<string, ArrayBuffer>
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      // v1 曾按 basename 分散存储，会破坏同名资源。v2 改为单条原子记录。
      if (req.result.objectStoreNames.contains('assets')) req.result.deleteObjectStore('assets')
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
  })
}

async function putRecord(record: StoredRecord): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record, RECORD_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('模型保存失败'))
      tx.onabort = () => reject(tx.error ?? new Error('模型保存已中止'))
    })
  } finally {
    db.close()
  }
}

async function getRecord(): Promise<StoredRecord | undefined> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(RECORD_KEY)
      req.onsuccess = () => resolve(req.result as StoredRecord | undefined)
      req.onerror = () => reject(req.error ?? new Error('模型读取失败'))
    })
  } finally {
    db.close()
  }
}

async function clearRecord(): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(RECORD_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('模型移除失败'))
    })
  } finally {
    db.close()
  }
}

export function readConfig(): StoredModel['config'] | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as StoredModel['config']
    if (parsed !== null && typeof parsed === 'object'
      && (parsed.kind === 'zip' || parsed.kind === 'url')
      && typeof parsed.name === 'string') return parsed
    return null
  } catch {
    return null
  }
}

function asRecord(stored: StoredModel): StoredRecord {
  const files: Record<string, ArrayBuffer> = {}
  for (const [path, bytes] of Object.entries(stored.files)) {
    files[path] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
  return {
    schemaVersion: MODEL_SCHEMA_VERSION,
    config: stored.config,
    modelJson: stored.modelJson,
    rootJsonPath: stored.rootJsonPath,
    files,
  }
}

async function saveStoredModel(stored: StoredModel): Promise<void> {
  await putRecord(asRecord(stored))
  localStorage.setItem(CONFIG_KEY, JSON.stringify(stored.config))
}

export interface ImportResult {
  config: StoredModel['config']
  name: string
}

/** ZIP → 校验 model3.json 与所有资源 → IndexedDB 原子替换。 */
export async function importModelFromZip(bytes: ArrayBuffer): Promise<ImportResult> {
  const zipModel = findModelRootZip(new Uint8Array(bytes))
  if (zipModel === null) throw new Error('ZIP 中没有找到 model3.json（仅支持 Cubism 3/4/5）')
  const rootEntry = zipModel.entries.find((entry) => entry.path === zipModel.rootJsonPath)
  if (rootEntry === undefined) throw new Error('模型根 JSON 缺失')

  let modelJson: unknown
  try {
    modelJson = JSON.parse(new TextDecoder().decode(rootEntry.bytes))
  } catch {
    throw new Error(`模型 JSON 解析失败：${zipModel.rootJsonPath}`)
  }
  const stored = materializeZipModel(zipModel, modelJson)
  stored.config.importedAt = Date.now()
  await saveStoredModel(stored)
  return { config: stored.config, name: stored.config.name }
}

/** URL → 下载 model3.json 及其引用资源 → IndexedDB 原子替换。 */
export async function importModelFromUrl(input: string): Promise<ImportResult> {
  let jsonUrl: URL
  try {
    jsonUrl = new URL(input, window.location.href)
  } catch {
    throw new Error('模型 URL 无效')
  }
  if (!['http:', 'https:'].includes(jsonUrl.protocol)) throw new Error('模型 URL 仅支持 HTTP/HTTPS')
  if (!jsonUrl.pathname.toLowerCase().endsWith('.model3.json')) throw new Error('URL 必须指向 .model3.json')

  const response = await fetch(jsonUrl.href, { cache: 'no-store', mode: 'cors', credentials: 'omit' })
  if (!response.ok) throw new Error(`获取模型 JSON 失败：HTTP ${response.status}`)
  const modelJson: unknown = await response.json()
  const refs = assetRefsFromModelJson(modelJson, jsonUrl.href)
  if (refs === null) throw new Error('模型 JSON 中没有可用资源')

  const files: Record<string, Uint8Array> = {}
  await Promise.all(refs.files.map(async (reference) => {
    const absolute = new URL(reference, jsonUrl).href
    const assetResponse = await fetch(absolute, { cache: 'no-store', mode: 'cors', credentials: 'omit' })
    if (!assetResponse.ok) throw new Error(`下载资源失败：${reference}（HTTP ${assetResponse.status}）`)
    files[reference] = new Uint8Array(await assetResponse.arrayBuffer())
  }))

  const name = basename(jsonUrl.pathname).replace(/\.model3\.json$/iu, '') || 'URL 模型'
  const config: StoredModel['config'] = {
    kind: 'url',
    name,
    url: jsonUrl.href,
    rootJsonPath: jsonUrl.pathname,
    importedAt: Date.now(),
    schemaVersion: MODEL_SCHEMA_VERSION,
  }
  const stored: StoredModel = { config, files, modelJson, rootJsonPath: jsonUrl.pathname }
  await saveStoredModel(stored)
  return { config, name }
}

/** 恢复已持久化模型；旧 schema 自动视为无效并由 UI 回退默认 PNG。 */
export async function loadStoredModel(): Promise<StoredModel | null> {
  const record = await getRecord()
  if (record === undefined || record.schemaVersion !== MODEL_SCHEMA_VERSION) return null
  const files: Record<string, Uint8Array> = {}
  for (const [path, buffer] of Object.entries(record.files)) files[path] = new Uint8Array(buffer)
  return {
    config: record.config,
    files,
    modelJson: record.modelJson,
    rootJsonPath: record.rootJsonPath,
  }
}

/** 移除已导入模型并恢复默认鲸鱼娘。 */
export async function removeStoredModel(): Promise<void> {
  await clearRecord()
  localStorage.removeItem(CONFIG_KEY)
}
