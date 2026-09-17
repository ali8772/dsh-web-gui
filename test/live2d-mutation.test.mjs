import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadMutationModule() {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-mutation-test-'))
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
  const mod = await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
  return { ...mod, cleanup: () => rm(temp, { recursive: true, force: true }) }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function staged(label, events) {
  return {
    commit() { events.push(`commit:${label}`) },
    discard() { events.push(`discard:${label}`) },
  }
}

test('a durable import commits once started and the latest queued import supersedes it', async () => {
  const { createLive2DMutationQueue, replaceLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const queue = createLive2DMutationQueue()
    const firstSaveStarted = deferred()
    const allowFirstSave = deferred()
    const events = []
    let durable = 'previous'
    let operation = 1
    const storage = {
      async save(value) {
        events.push(`save:${value}`)
        durable = value
        if (value === 'old') {
          firstSaveStarted.resolve()
          await allowFirstSave.promise
        }
      },
      async remove() { events.push('remove'); durable = null },
    }

    const oldImport = replaceLive2DIfCurrent(
      queue, () => operation === 1, 'old', storage,
      async () => staged('old', events),
    )
    await firstSaveStarted.promise

    operation = 2
    const newImport = replaceLive2DIfCurrent(
      queue, () => operation === 2, 'new', storage,
      async () => staged('new', events),
    )
    allowFirstSave.resolve()

    assert.equal(await oldImport, true)
    assert.equal(await newImport, true)
    assert.equal(durable, 'new')
    assert.deepEqual(events, [
      'save:old',
      'commit:old',
      'save:new',
      'commit:new',
    ])
  } finally {
    await cleanup()
  }
})

test('failed removal preserves the active renderer and durable model', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-remove-failure-'))
  try {
    const { createLive2DMutationQueue, useDefaultLive2DIfCurrent } = await loadMutationModule(temp)
    const queue = createLive2DMutationQueue()
    const active = { disposed: false }
    let durable = { id: 'active' }

    await assert.rejects(
      useDefaultLive2DIfCurrent(
        queue,
        () => true,
        async () => { throw new Error('delete failed') },
        () => { active.disposed = true; durable = null },
      ),
      /delete failed/,
    )
    assert.deepEqual(durable, { id: 'active' })
    assert.equal(active.disposed, false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('default fallback queued during an import runs after its durable commit', async () => {
  const { createLive2DMutationQueue, replaceLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const queue = createLive2DMutationQueue()
    const saveStarted = deferred()
    const allowSave = deferred()
    const events = []
    let durable = 'previous'
    let operation = 1
    const storage = {
      async save(value) {
        events.push(`save:${value}`)
        durable = value
        if (value === 'incoming') {
          saveStarted.resolve()
          await allowSave.promise
        }
      },
      async remove() { events.push('remove'); durable = null },
    }

    const importing = replaceLive2DIfCurrent(
      queue, () => operation === 1, 'incoming', storage,
      async () => staged('incoming', events),
    )
    await saveStarted.promise

    operation = 2
    const removing = queue.run(storage.remove)
    allowSave.resolve()

    assert.equal(await importing, true)
    await removing
    assert.equal(durable, null)
    assert.deepEqual(events, [
      'save:incoming',
      'commit:incoming',
      'remove',
    ])
  } finally {
    await cleanup()
  }
})

test('failed staged replacement leaves the previous durable model untouched', async () => {
  const { createLive2DMutationQueue, replaceLive2DIfCurrent, cleanup } = await loadMutationModule()
  try {
    const queue = createLive2DMutationQueue()
    let durable = 'previous'
    const storage = {
      async save(value) { durable = value },
      async remove() { durable = null },
    }
    await assert.rejects(
      replaceLive2DIfCurrent(queue, () => true, 'broken', storage, async () => {
        throw new Error('renderer failed')
      }),
      /renderer failed/,
    )
    assert.equal(durable, 'previous')
  } finally {
    await cleanup()
  }
})
