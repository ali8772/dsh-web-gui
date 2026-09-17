import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadMutationModule() {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-delete-test-'))
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

test('deleting an active saved model switches the renderer to default only after durable deletion', async () => {
  const { createLive2DMutationQueue, deleteLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const events = []
    const deleted = await deleteLive2DIfCurrent(
      createLive2DMutationQueue(),
      () => true,
      async () => { events.push('delete'); return { deleted: true, wasActive: true } },
      () => { events.push('default') },
    )
    assert.equal(deleted, true)
    assert.deepEqual(events, ['delete', 'default'])
  } finally {
    await cleanup()
  }
})

test('default fallback that becomes stale after durable commit still switches the renderer', async () => {
  const { createLive2DMutationQueue, useDefaultLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    let current = true
    const events = []
    const changed = await useDefaultLive2DIfCurrent(
      createLive2DMutationQueue(),
      () => current,
      async () => { events.push('default:durable'); current = false },
      () => { events.push('default:renderer') },
    )
    assert.equal(changed, true)
    assert.deepEqual(events, ['default:durable', 'default:renderer'])
  } finally {
    await cleanup()
  }
})

test('deleting an inactive saved model leaves the active renderer alone', async () => {
  const { createLive2DMutationQueue, deleteLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const events = []
    await deleteLive2DIfCurrent(
      createLive2DMutationQueue(),
      () => true,
      async () => { events.push('delete'); return { deleted: true, wasActive: false } },
      () => { events.push('default') },
    )
    assert.deepEqual(events, ['delete'])
  } finally {
    await cleanup()
  }
})

test('active deletion that becomes stale after its durable commit still switches to default', async () => {
  const { createLive2DMutationQueue, deleteLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    let current = true
    const events = []
    const deleted = await deleteLive2DIfCurrent(
      createLive2DMutationQueue(),
      () => current,
      async () => { events.push('delete'); current = false; return { deleted: true, wasActive: true } },
      () => { events.push('default') },
    )
    assert.equal(deleted, true)
    assert.deepEqual(events, ['delete', 'default'])
  } finally {
    await cleanup()
  }
})

test('deletion uses the atomic durable result instead of stale UI active state', async () => {
  const { createLive2DMutationQueue, deleteLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const events = []
    await deleteLive2DIfCurrent(
      createLive2DMutationQueue(),
      () => true,
      async () => ({ deleted: false, wasActive: false }),
      () => { events.push('default') },
    )
    assert.deepEqual(events, [])
  } finally {
    await cleanup()
  }
})
