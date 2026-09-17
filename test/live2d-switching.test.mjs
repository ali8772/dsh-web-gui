import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadMutationModule() {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-switch-test-'))
  const outfile = join(temp, 'mutation.mjs')
  await build({
    entryPoints: [join(projectRoot, 'src/client/live2d/mutation.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome100',
    outfile,
    logLevel: 'silent',
  })
  return {
    ...await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`),
    cleanup: () => rm(temp, { recursive: true, force: true }),
  }
}

function staged(label, events, fail = false) {
  return {
    commit() {
      if (fail) throw new Error('commit failed')
      events.push(`commit:${label}`)
    },
    discard() { events.push(`discard:${label}`) },
  }
}

test('saved-model switch activates only after staging and rolls durability back on render failure', async () => {
  const { createLive2DMutationQueue, switchLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const events = []
    let active = 'old'
    const storage = {
      async load(id) { events.push(`load:${id}`); return { id } },
      async activate(id) { events.push(`activate:${id}`); active = id; return true },
    }

    await assert.rejects(
      switchLive2DIfCurrent(
        createLive2DMutationQueue(),
        () => true,
        'next',
        storage,
        async () => { throw new Error('renderer failed') },
      ),
      /renderer failed/,
    )
    assert.equal(active, 'old')
    assert.deepEqual(events, ['load:next'])
  } finally {
    await cleanup()
  }
})

test('a saved-model switch that becomes stale after activation still commits before the queued operation', async () => {
  const { createLive2DMutationQueue, switchLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const events = []
    let active = 'old'
    let current = true
    const storage = {
      async load(id) { events.push(`load:${id}`); return { id } },
      async activate(id) { events.push(`activate:${id}`); active = id; current = false; return true },
    }
    const switched = await switchLive2DIfCurrent(
      createLive2DMutationQueue(),
      () => current,
      'next',
      storage,
      async () => staged('next', events),
    )
    assert.equal(switched, true)
    assert.equal(active, 'next')
    assert.deepEqual(events, ['load:next', 'activate:next', 'commit:next'])
  } finally {
    await cleanup()
  }
})

test('saved-model switch commits a staged renderer after durable activation succeeds', async () => {
  const { createLive2DMutationQueue, switchLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const events = []
    let active = 'old'
    const storage = {
      async load(id) { events.push(`load:${id}`); return { id } },
      async activate(id) { events.push(`activate:${id}`); active = id; return true },
    }
    const switched = await switchLive2DIfCurrent(
      createLive2DMutationQueue(),
      () => true,
      'next',
      storage,
      async () => staged('next', events),
    )
    assert.equal(switched, true)
    assert.equal(active, 'next')
    assert.deepEqual(events, ['load:next', 'activate:next', 'commit:next'])
  } finally {
    await cleanup()
  }
})
