/**
 * Live2D 导入与持久化层（无 PIXI 依赖）。
 * 模型资产只保存在当前浏览器的 IndexedDB；URL 导入下载后同样本地化。
 */

import {
  assetRefsFromModelJson,
  basename,
  findModelRootZip,
  materializeZipModel,
  createModelId,
  modelImportBudget,
  StoredModel,
} from './parse'
import { downloadModelFiles, readBoundedResponse } from './model-downloader.ts'
import {
  createLive2DModelLibrary,
  type Live2DDeleteResult,
  type Live2DLibraryStore,
  type Live2DModelSummary,
} from './library.ts'

const DB_NAME = 'dsh-whale-pet-live2d'
const STORE = 'models'
const MODEL_SCHEMA_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3)
    req.onupgradeneeded = () => {
      // v1 曾按 basename 分散存储；v2 改为单模型原子记录；v3 引入五模型 MRU 清单。
      if (req.result.objectStoreNames.contains('assets')) req.result.deleteObjectStore('assets')
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close()
      resolve(req.result)
    }
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'))
  })
}

function requestResult<T>(request: IDBRequest<T>, fallback: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error(fallback))
  })
}

class IndexedDbLive2DLibraryStore implements Live2DLibraryStore {
  async read(key: string): Promise<unknown> {
    return (await this.readMany([key]))[0]
  }

  async readMany(keys: readonly string[]): Promise<readonly unknown[]> {
    const db = await openDb()
    try {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      return await Promise.all(keys.map((key) => requestResult(store.get(key), '模型读取失败')))
    } finally {
      db.close()
    }
  }

  async readRelated(key: string, relatedKey: (current: unknown) => string | null): Promise<readonly [unknown, unknown]> {
    const db = await openDb()
    try {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const current = await requestResult(store.get(key), '模型读取失败')
      const related = relatedKey(current)
      if (related === null) return [current, undefined]
      return [current, await requestResult(store.get(related), '模型读取失败')]
    } finally {
      db.close()
    }
  }

  async updateWithRelated<T>(key: string, relatedKey: string, change: (current: unknown, related: unknown) => {
    readonly value: unknown
    readonly puts?: readonly { readonly key: string; readonly value: unknown }[]
    readonly deletes?: readonly string[]
    readonly result: T
  }): Promise<T> {
    const db = await openDb()
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const primaryRequest = store.get(key)
        const relatedRequest = store.get(relatedKey)
        let result: T
        let applied = false
        const apply = (): void => {
          if (applied || primaryRequest.readyState !== 'done' || relatedRequest.readyState !== 'done') return
          applied = true
          try {
            const next = change(primaryRequest.result, relatedRequest.result)
            result = next.result
            store.put(next.value, key)
            for (const put of next.puts ?? []) store.put(put.value, put.key)
            for (const deleted of next.deletes ?? []) store.delete(deleted)
          } catch (cause) {
            tx.abort()
            reject(cause)
          }
        }
        primaryRequest.onsuccess = apply
        relatedRequest.onsuccess = apply
        primaryRequest.onerror = () => reject(primaryRequest.error ?? new Error('模型读取失败'))
        relatedRequest.onerror = () => reject(relatedRequest.error ?? new Error('模型读取失败'))
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error ?? new Error('模型保存失败'))
        tx.onabort = () => reject(tx.error ?? new Error('模型保存已中止'))
      })
    } finally {
      db.close()
    }
  }

  async update<T>(key: string, change: (current: unknown) => {
    readonly value: unknown
    readonly puts?: readonly { readonly key: string; readonly value: unknown }[]
    readonly deletes?: readonly string[]
    readonly result: T
  }): Promise<T> {
    return this.updateWithRelated(key, key, (current) => change(current))
  }
}

const indexedDbStore = new IndexedDbLive2DLibraryStore()

const library = createLive2DModelLibrary(indexedDbStore)

export async function listStoredModels(): Promise<readonly Live2DModelSummary[]> {
  return library.list()
}

export async function saveStoredModel(stored: StoredModel): Promise<void> {
  await library.save(stored)
}

export async function activateStoredModel(id: string): Promise<boolean> {
  return library.activate(id)
}

export async function loadStoredModelById(id: string): Promise<StoredModel | null> {
  return library.loadById(id)
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
export async function prepareModelFromUrl(input: string, signal?: AbortSignal): Promise<PreparedImport> {
  let jsonUrl: URL
  try {
    jsonUrl = new URL(input, window.location.href)
  } catch {
    throw new Error('模型 URL 无效')
  }
  if (!['http:', 'https:'].includes(jsonUrl.protocol)) throw new Error('模型 URL 仅支持 HTTP/HTTPS')
  if (!jsonUrl.pathname.toLowerCase().endsWith('.model3.json')) throw new Error('URL 必须指向 .model3.json')

  const budget = modelImportBudget()
  const response = await fetch(jsonUrl.href, { cache: 'no-store', mode: 'cors', credentials: 'omit', signal })
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
    signal,
  })
  const files: Record<string, Uint8Array> = {}
  for (const [absolute, bytes] of Object.entries(downloaded)) {
    const reference = absoluteToReference.get(absolute)
    if (reference !== undefined) files[reference] = bytes
  }

  const name = basename(jsonUrl.pathname).replace(/\.model3\.json$/iu, '') || 'URL 模型'
  const config: StoredModel['config'] = {
    kind: 'url',
    modelId: createModelId(),
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
  return library.load()
}

/** 恢复默认鲸鱼娘，但保留最近模型以便快速切换。 */
export async function useDefaultModel(): Promise<void> {
  await library.useDefault()
}

/** 从最近模型库永久删除一项；若该项正启用则同时恢复默认鲸鱼娘。 */
export async function deleteStoredModel(id: string): Promise<Live2DDeleteResult> {
  return library.delete(id)
}
