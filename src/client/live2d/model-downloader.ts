export interface ModelDownloadOptions {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxConcurrent: number
  readonly signal?: AbortSignal
}

/** Reads a response incrementally so an absent or dishonest Content-Length cannot bypass budgets. */
export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  errorMessage = 'model file exceeds budget',
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(errorMessage)
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel(errorMessage)
        throw new Error(errorMessage)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Downloads a finite resource set through a bounded worker pool. */
export async function downloadModelFiles(
  urls: readonly string[],
  options: ModelDownloadOptions,
): Promise<Record<string, Uint8Array>> {
  if (urls.length > options.maxFiles) throw new Error('model file count exceeds budget')
  if (options.maxConcurrent < 1) throw new Error('model concurrency budget must be positive')
  const output: Record<string, Uint8Array> = {}
  let next = 0
  let total = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= urls.length) return
      const url = urls[index]!
      const response = await options.fetch(url, {
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        signal: options.signal,
      })
      if (!response.ok) throw new Error(`model resource failed: ${url} (HTTP ${response.status})`)
      const remaining = options.maxTotalBytes - total
      if (remaining < 0) throw new Error('model total download budget exceeded')
      const bytes = await readBoundedResponse(
        response,
        Math.min(options.maxFileBytes, remaining),
        remaining < options.maxFileBytes ? 'model total download budget exceeded' : `model file exceeds budget: ${url}`,
      )
      total += bytes.byteLength
      output[url] = bytes
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(options.maxConcurrent, urls.length) },
    () => worker(),
  ))
  return output
}
