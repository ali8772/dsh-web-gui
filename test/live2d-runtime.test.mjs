import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

test('Cubism runtime loader is local, coalesced, verified, and retryable', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-runtime-test-'))
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  try {
    const outfile = join(temp, 'runtime.mjs')
    await build({
      entryPoints: [join(projectRoot, 'src/client/live2d/runtime.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome100',
      outfile,
      logLevel: 'silent',
    })

    const scripts = []
    globalThis.window = {}
    globalThis.document = {
      createElement(tag) {
        assert.equal(tag, 'script')
        const attributes = new Map()
        return {
          src: '',
          async: false,
          onload: null,
          onerror: null,
          setAttribute(name, value) { attributes.set(name, value) },
          hasAttribute(name) { return attributes.has(name) },
          remove() {
            const index = scripts.indexOf(this)
            if (index !== -1) scripts.splice(index, 1)
          },
        }
      },
      querySelector(selector) {
        if (!selector.includes('data-dsh-whale-pet-cubism-core')) return null
        return scripts.find((script) => script.hasAttribute('data-dsh-whale-pet-cubism-core')) ?? null
      },
      head: {
        appendChild(script) { scripts.push(script) },
      },
    }

    const { LOCAL_CUBISM_CORE_URL, cubismCoreReady, ensureCubismCore } = await import(`${pathToFileURL(outfile).href}?test=1`)
    assert.equal(LOCAL_CUBISM_CORE_URL, '/dsh-whale-pet-live2dcubismcore.min.js')
    assert.equal(cubismCoreReady(), false)

    const first = ensureCubismCore()
    const concurrent = ensureCubismCore()
    assert.equal(first, concurrent)
    assert.equal(scripts.length, 1)
    assert.equal(scripts[0].src, LOCAL_CUBISM_CORE_URL)
    assert.ok(!scripts[0].src.startsWith('http'))

    scripts[0].onerror()
    await assert.rejects(first, /无法加载本地 Cubism Core/)
    assert.equal(scripts.length, 0)

    const retry = ensureCubismCore()
    assert.equal(scripts.length, 1)
    globalThis.window.Live2DCubismCore = { Version: {} }
    scripts[0].onload()
    await retry
    assert.equal(cubismCoreReady(), true)
    await ensureCubismCore()
    assert.equal(scripts.length, 1)
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    await rm(temp, { recursive: true, force: true })
  }
})
