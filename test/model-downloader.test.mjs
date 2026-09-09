import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadModule(temp) {
  const outfile = join(temp, 'model-downloader.mjs')
  await build({ entryPoints: [join(projectRoot, 'src/client/live2d/model-downloader.ts')], bundle: true, format: 'esm', platform: 'node', target: 'node24', outfile })
  return import(pathToFileURL(outfile).href)
}

function response(bytes, length = bytes.byteLength) {
  return new Response(bytes, { status: 200, headers: { 'content-length': String(length) } })
}

test('ModelDownloader bounds concurrency and total downloaded bytes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-download-test-'))
  try {
    const { downloadModelFiles } = await loadModule(temp)
    let active = 0
    let peak = 0
    const files = await downloadModelFiles(['a', 'b', 'c'], {
      maxFiles: 4, maxFileBytes: 4, maxTotalBytes: 8, maxConcurrent: 2,
      fetch: async (url) => {
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        return response(new Uint8Array([String(url).charCodeAt(0)]), 1)
      },
    })
    assert.equal(peak <= 2, true)
    assert.deepEqual(Object.keys(files), ['a', 'b', 'c'])
    await assert.rejects(
      downloadModelFiles(['a', 'b'], {
        maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 5, maxConcurrent: 1,
        fetch: async () => response(new Uint8Array([1, 2, 3]), 3),
      }),
      /total.*budget/i,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('ModelDownloader stops an undeclared streaming body at the file budget', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-download-test-'))
  try {
    const { downloadModelFiles } = await loadModule(temp)
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array([1, 2, 3]))
        if (pulls > 10) controller.close()
      },
      cancel() { cancelled = true },
    })
    await assert.rejects(
      downloadModelFiles(['stream'], {
        maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 20, maxConcurrent: 1,
        fetch: async () => new Response(body, { status: 200 }),
      }),
      /file.*budget/i,
    )
    assert.equal(cancelled, true)
    assert.equal(pulls < 10, true)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('ModelDownloader rejects an oversized declared file before reading its body', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-download-test-'))
  try {
    const { downloadModelFiles } = await loadModule(temp)
    let bodyRead = false
    const oversized = new Response(null, { status: 200, headers: { 'content-length': '99' } })
    Object.defineProperty(oversized, 'arrayBuffer', { value: async () => { bodyRead = true; return new ArrayBuffer(0) } })
    await assert.rejects(
      downloadModelFiles(['large'], {
        maxFiles: 1, maxFileBytes: 4, maxTotalBytes: 4, maxConcurrent: 1,
        fetch: async () => oversized,
      }),
      /file.*budget/i,
    )
    assert.equal(bodyRead, false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
