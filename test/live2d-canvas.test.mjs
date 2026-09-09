import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

test('Live2D handles expose an active-state control used to pause hidden rendering', async () => {
  const core = await readFile(resolve(projectRoot, 'src/client/live2d/core.ts'), 'utf8')
  const widget = await readFile(resolve(projectRoot, 'src/client/widget.tsx'), 'utf8')
  assert.match(core, /setActive\(active:\s*boolean\):\s*void/)
  assert.match(core, /app\.ticker\.(start|stop)\(\)/)
  assert.match(widget, /visibilitychange/)
  assert.match(widget, /const visible = document\.visibilityState === 'visible'/)
  assert.match(widget, /setActive\(visible\)/)
})

test('every renderer leases a fresh canvas and release removes only its own canvas', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-canvas-test-'))
  const previousDocument = globalThis.document
  try {
    const outfile = join(temp, 'canvas.mjs')
    await build({
      entryPoints: [join(projectRoot, 'src/client/live2d/canvas.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome100',
      outfile,
      logLevel: 'silent',
    })

    let nextId = 0
    globalThis.document = {
      createElement(tag) {
        assert.equal(tag, 'canvas')
        const node = {
          id: ++nextId,
          className: '',
          parentNode: null,
          removeCalls: 0,
          remove() {
            this.removeCalls += 1
            if (this.parentNode === null) return
            const index = this.parentNode.children.indexOf(this)
            if (index !== -1) this.parentNode.children.splice(index, 1)
            this.parentNode = null
          },
        }
        return node
      },
    }
    const container = {
      children: [],
      appendChild(node) {
        node.parentNode = this
        this.children.push(node)
      },
    }

    const { leaseLive2DCanvas } = await import(`${pathToFileURL(outfile).href}?test=1`)
    const first = leaseLive2DCanvas(container)
    assert.equal(first.canvas.className, 'wp-live2d-canvas')
    assert.deepEqual(container.children, [first.canvas])

    first.release()
    first.release()
    assert.equal(first.canvas.removeCalls, 1, 'release must be idempotent')
    assert.deepEqual(container.children, [])

    const second = leaseLive2DCanvas(container)
    assert.notEqual(second.canvas, first.canvas, 'destroyed/lost WebGL canvas must never be reused')
    assert.equal(second.canvas.id, 2)
    assert.deepEqual(container.children, [second.canvas])

    second.release()
    assert.deepEqual(container.children, [])
  } finally {
    globalThis.document = previousDocument
    await rm(temp, { recursive: true, force: true })
  }
})
