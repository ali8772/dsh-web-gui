import { WHALE_PET_PATHS } from '../../shared/contract.ts'
import type { PreparedImport } from './ui.ts'

const ZIP_WORKER_URL = WHALE_PET_PATHS.live2dZipWorker

/** Runs ZIP decompression/validation off the UI thread and transfers ownership of input bytes. */
export function prepareModelFromZipWorker(bytes: ArrayBuffer): Promise<PreparedImport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(ZIP_WORKER_URL, { type: 'module', name: 'dsh-whale-pet-live2d-zip' })
    const finish = (): void => worker.terminate()
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || 'Live2D ZIP Worker 失败'))
    }
    worker.onmessage = (event: MessageEvent<{ ok: boolean; result?: PreparedImport; error?: string }>) => {
      finish()
      if (event.data.ok && event.data.result !== undefined) resolve(event.data.result)
      else reject(new Error(event.data.error ?? 'Live2D ZIP 解析失败'))
    }
    worker.postMessage(bytes, [bytes])
  })
}
