import { WHALE_PET_PATHS } from '../../shared/contract.ts'
import type { PreparedImport } from './ui.ts'

const ZIP_WORKER_URL = WHALE_PET_PATHS.live2dZipWorker

/** Runs ZIP decompression/validation off the UI thread and transfers ownership of input bytes. */
export function prepareModelFromZipWorker(bytes: ArrayBuffer, signal?: AbortSignal): Promise<PreparedImport> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Live2D ZIP import aborted', 'AbortError'))
      return
    }
    const worker = new Worker(ZIP_WORKER_URL, { type: 'module', name: 'dsh-whale-pet-live2d-zip' })
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      worker.terminate()
    }
    const abort = (): void => {
      finish()
      reject(new DOMException('Live2D ZIP import aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
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
