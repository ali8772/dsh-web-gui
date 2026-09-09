import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadWidgetModule(temp) {
  const outfile = join(temp, 'widget-under-test.mjs')
  await build({
    entryPoints: [join(projectRoot, 'src/client/widget.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome100',
    outfile,
    loader: { '.png': 'dataurl' },
    logLevel: 'silent',
    plugins: [{
      name: 'react-test-stubs',
      setup(ctx) {
        ctx.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'react-test' }))
        ctx.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'react-test' }))
        ctx.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react-jsx-runtime', namespace: 'react-test' }))
        ctx.onLoad({ filter: /.*/, namespace: 'react-test' }, ({ path }) => ({
          contents: path === 'react-dom'
            ? 'export const createPortal = (value) => value'
            : path === 'react-jsx-runtime'
              ? 'export const jsx = () => null; export const jsxs = jsx; export const Fragment = Symbol()'
              : 'export const createElement = () => null; export const useEffect = () => {}; export const useRef = (value) => ({ current: value }); export const useState = (value) => [value, () => {}]',
        }))
      },
    }],
  })
  return import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
}

function runningSession(id, updatedAt, extra = {}) {
  return { running: true, displayTitle: id, updatedAt, ...extra }
}

test('a display-only parent is never reported as a completed running task', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-task-parent-'))
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  try {
    globalThis.window = {
      setInterval() { return 1 },
      clearInterval() {},
    }
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), body: options?.body })
      return {
        ok: true,
        async json() {
          return String(url).endsWith('/tasks') ? { ok: true, tasks: [] } : { ok: true, summary: { found: false } }
        },
      }
    }

    let notify = () => {}
    let snapshot = {
      byId: {
        parent: { running: false, displayTitle: 'parent', updatedAt: 1 },
        child: runningSession('child', 2, { parentId: 'parent' }),
      },
    }
    const list = {
      getSnapshot: () => snapshot,
      subscribe(callback) {
        notify = callback
        return () => {}
      },
    }

    const { attachTaskSource } = await loadWidgetModule(temp)
    const dispose = attachTaskSource(list)
    requests.length = 0
    snapshot = {
      byId: {
        parent: snapshot.byId.parent,
        child: { ...snapshot.byId.child, running: false },
      },
    }
    notify()
    await Promise.resolve()

    assert.deepEqual(
      requests.filter((request) => request.url.endsWith('/task-summary')).map((request) => JSON.parse(request.body).id),
      ['child'],
    )
    dispose()
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
    await rm(temp, { recursive: true, force: true })
  }
})

test('bursty task snapshots coalesce progress requests and the latest snapshot wins', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-task-source-'))
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  try {
    globalThis.window = { setInterval() { return 1 }, clearInterval() {} }
    const requests = []
    let resolveFirst
    globalThis.fetch = (url, options) => {
      if (!String(url).endsWith('/tasks')) return Promise.resolve({ ok: true, async json() { return { ok: true, summary: { found: false } } } })
      requests.push(JSON.parse(options.body).ids)
      if (requests.length === 1) {
        return new Promise((resolve) => { resolveFirst = () => resolve({ ok: true, async json() { return { ok: true, tasks: [] } } }) })
      }
      return Promise.resolve({ ok: true, async json() { return { ok: true, tasks: [] } } })
    }
    let notify = () => {}
    let snapshot = { byId: { first: runningSession('first', 1) } }
    const list = {
      getSnapshot: () => snapshot,
      subscribe(callback) { notify = callback; return () => {} },
    }
    const { attachTaskSource } = await loadWidgetModule(temp)
    const dispose = attachTaskSource(list)
    snapshot = { byId: { second: runningSession('second', 2) } }
    notify()
    snapshot = { byId: { third: runningSession('third', 3) } }
    notify()
    assert.deepEqual(requests, [['first']])
    resolveFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(requests, [['first'], ['third']])
    dispose()
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
    await rm(temp, { recursive: true, force: true })
  }
})

test('reordering more than ten running sessions never reports a displaced task as complete', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-task-source-'))
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  try {
    globalThis.window = {
      setInterval() { return 1 },
      clearInterval() {},
    }
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), body: options?.body })
      return {
        ok: true,
        async json() {
          return String(url).endsWith('/tasks') ? { ok: true, tasks: [] } : { ok: true, summary: { found: false } }
        },
      }
    }

    let notify = () => {}
    let snapshot = {
      byId: Object.fromEntries(Array.from({ length: 11 }, (_, index) => {
        const rank = index + 1
        return [`task-${rank}`, runningSession(`task-${rank}`, 100 - rank)]
      })),
    }
    const list = {
      getSnapshot: () => snapshot,
      subscribe(callback) {
        notify = callback
        return () => {}
      },
    }

    const { attachTaskSource } = await loadWidgetModule(temp)
    const dispose = attachTaskSource(list)
    requests.length = 0

    snapshot = {
      byId: {
        ...snapshot.byId,
        'task-11': runningSession('task-11', 1_000),
      },
    }
    notify()

    assert.deepEqual(
      requests.filter((request) => request.url.endsWith('/task-summary')),
      [],
      'a still-running session falling out of the visible top ten is not a completion edge',
    )
    dispose()
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
    await rm(temp, { recursive: true, force: true })
  }
})
