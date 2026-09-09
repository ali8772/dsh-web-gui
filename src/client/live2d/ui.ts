/**
 * Live2D 导入与持久化层（无 PIXI 依赖）。
 * 模型资产只保存在当前浏览器的 IndexedDB；URL 导入下载后同样本地化。
 */

import {
  assetRefsFromModelJson,
  basename,
  findModelRootZip,
  materializeZipModel,
  modelImportBudget,
  StoredModel,
} from './parse'
import { downloadModelFiles, readBoundedResponse } from './model-downloader.ts'
import {
  createLive2DRepository,
  type Live2DRecord,
} from './repository.ts'

const DB_NAME = 'dsh-whale-pet-live2d'
const STORE = 'models'
const RECORD_KEY = 'active'
const MODEL_SCHEMA_VERSION = 1

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

async function putRecord(record: Live2DRecord): Promise<void> {
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

async function getRecord(): Promise<Live2DRecord | undefined> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(RECORD_KEY)
      req.onsuccess = () => resolve(req.result as Live2DRecord | undefined)
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

const repository = createLive2DRepository({
  read: getRecord,
  write: putRecord,
  clear: clearRecord,
})

export async function readConfig(): Promise<StoredModel['config'] | null> {
  return repository.config()
}

export async function saveStoredModel(stored: StoredModel): Promise<void> {
  await repository.save(stored)
}

export interface PreparedImport {
  config: StoredModel['config']
  name: string
  stored: StoredModel
}

/** ZIP → 校验 model3.json 与所有资源；由调用方在最新操作检查后提交。 */
export async function prepareModelFromZip(bytes: ArrayBuffer): Promise<PreparedImport> {
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
  return { config: stored.config, name: stored.config.name, stored }
}

/** URL → 下载 model3.json 及其引用资源；由调用方在最新操作检查后提交。 */
export async function prepareModelFromUrl(input: string): Promise<PreparedImport> {
  let jsonUrl: URL
  try {
    jsonUrl = new URL(input, window.location.href)
  } catch {
    throw new Error('模型 URL 无效')
  }
  if (!['http:', 'https:'].includes(jsonUrl.protocol)) throw new Error('模型 URL 仅支持 HTTP/HTTPS')
  if (!jsonUrl.pathname.toLowerCase().endsWith('.model3.json')) throw new Error('URL 必须指向 .model3.json')

  const budget = modelImportBudget()
  const response = await fetch(jsonUrl.href, { cache: 'no-store', mode: 'cors', credentials: 'omit' })
  if (!response.ok) throw new Error(`获取模型 JSON 失败：HTTP ${response.status}`)
  const jsonBytes = await readBoundedResponse(response, budget.maxFileBytes, '模型 JSON 超过单文件大小限制')
  let modelJson: unknown
  try {
    modelJson = JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown
  } catch {
    throw new Error('模型 JSON 解析失败')
  }
  const refs = assetRefsFromModelJson(modelJson, jsonUrl.href)
  if (refs === null) throw new Error('模型 JSON 中没有可用资源')
  if (refs.files.length > budget.maxFiles) throw new Error('模型资源文件数超过限制')

  const absoluteToReference = new Map(refs.files.map((reference) => [new URL(reference, jsonUrl).href, reference]))
  const downloaded = await downloadModelFiles([...absoluteToReference.keys()], {
    fetch,
    maxFiles: budget.maxFiles,
    maxFileBytes: budget.maxFileBytes,
    maxTotalBytes: budget.maxTotalBytes - jsonBytes.byteLength,
    maxConcurrent: budget.maxConcurrent,
  })
  const files: Record<string, Uint8Array> = {}
  for (const [absolute, bytes] of Object.entries(downloaded)) {
    const reference = absoluteToReference.get(absolute)
    if (reference !== undefined) files[reference] = bytes
  }

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
  return { config, name, stored }
}

/** 恢复已持久化模型；旧 schema 自动视为无效并由 UI 回退默认 PNG。 */
export async function loadStoredModel(): Promise<StoredModel | null> {
  return repository.load()
}

/** 移除已导入模型并恢复默认鲸鱼娘。 */
export async function removeStoredModel(): Promise<void> {
  await repository.remove()
}
