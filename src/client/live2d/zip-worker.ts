import { findModelRootZip, materializeZipModel, type StoredModel } from './parse.ts'

export interface ZipWorkerResult {
  readonly config: StoredModel['config']
  readonly name: string
  readonly stored: StoredModel
}

self.onmessage = (event: MessageEvent<ArrayBuffer>): void => {
  try {
    const zipModel = findModelRootZip(new Uint8Array(event.data))
    if (zipModel === null) throw new Error('ZIP 中没有找到 model3.json（仅支持 Cubism 3/4/5）')
    const rootEntry = zipModel.entries.find((entry) => entry.path === zipModel.rootJsonPath)
    if (rootEntry === undefined) throw new Error('模型根 JSON 缺失')
    let modelJson: unknown
    try {
      modelJson = JSON.parse(new TextDecoder().decode(rootEntry.bytes)) as unknown
    } catch {
      throw new Error(`模型 JSON 解析失败：${zipModel.rootJsonPath}`)
    }
    const stored = materializeZipModel(zipModel, modelJson)
    stored.config.importedAt = Date.now()
    const result: ZipWorkerResult = { config: stored.config, name: stored.config.name, stored }
    self.postMessage({ ok: true, result })
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
