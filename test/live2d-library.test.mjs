import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadModule(temp) {
  const outfile = join(temp, 'library.mjs')
  await build({
    entryPoints: [join(projectRoot, 'src/client/live2d/library.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome100',
    outfile,
    logLevel: 'silent',
  })
  return import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
}

function memoryStore(initial = {}) {
  const records = new Map(Object.entries(structuredClone(initial)))
  let tail = Promise.resolve()
  return {
    async read(key) { return structuredClone(records.get(key)) },
    async readMany(keys) { return keys.map((key) => structuredClone(records.get(key))) },
    async readRelated(key, relatedKey) {
      const primary = structuredClone(records.get(key))
      const related = relatedKey(primary)
      return [primary, related === null ? undefined : structuredClone(records.get(related))]
    },
    keys() { return [...records.keys()] },
    seed(key, value) { records.set(key, structuredClone(value)) },
    updateWithRelated(key, relatedKey, change) {
      const result = tail.then(() => {
        const current = structuredClone(records.get(key))
        const related = structuredClone(records.get(relatedKey))
        const next = change(current, related)
        records.set(key, structuredClone(next.value))
        for (const put of next.puts ?? []) records.set(put.key, structuredClone(put.value))
        for (const deleted of next.deletes ?? []) records.delete(deleted)
        return structuredClone(next.result)
      })
      tail = result.then(() => undefined, () => undefined)
      return result
    },
    update(key, change) {
      const result = tail.then(() => {
        const next = change(structuredClone(records.get(key)))
        records.set(key, structuredClone(next.value))
        for (const put of next.puts ?? []) records.set(put.key, structuredClone(put.value))
        for (const deleted of next.deletes ?? []) records.delete(deleted)
        return structuredClone(next.result)
      })
      tail = result.then(() => undefined, () => undefined)
      return result
    },
  }
}

function model(id, name, importedAt = 1) {
  return {
    config: {
      kind: 'zip',
      modelId: id,
      name,
      rootJsonPath: `${name}.model3.json`,
      importedAt,
      schemaVersion: 1,
    },
    modelJson: { Version: 3, Name: name },
    rootJsonPath: `${name}.model3.json`,
    files: { [`${name}.moc3`]: new Uint8Array([1, 2, 3]) },
  }
}

function legacyRecord(stored) {
  const config = structuredClone(stored.config)
  delete config.modelId
  return {
    schemaVersion: 1,
    config,
    modelJson: structuredClone(stored.modelJson),
    rootJsonPath: stored.rootJsonPath,
    files: Object.fromEntries(Object.entries(stored.files).map(([path, bytes]) => [path, bytes.buffer.slice(0)])),
  }
}

test('saving a model makes it active and exposes it through the recent-model interface', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const library = createLive2DModelLibrary(memoryStore(), { now: () => 100 })
    const whale = model('model-whale', 'Whale')

    await library.save(whale)

    assert.deepEqual(await library.list(), [{
      id: 'model-whale',
      name: 'Whale',
      kind: 'zip',
      importedAt: 1,
      lastUsedAt: 100,
      active: true,
    }])
    assert.deepEqual(await library.load(), whale)
    assert.deepEqual(await library.loadById('model-whale'), whale)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('models without an ID receive and persist a generated stable ID', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const library = createLive2DModelLibrary(memoryStore(), { now: () => 100, createId: () => 'generated-id' })
    const imported = model('temporary', 'Imported')
    delete imported.config.modelId

    await library.save(imported)

    assert.equal((await library.list())[0].id, 'generated-id')
    assert.equal((await library.load()).config.modelId, 'generated-id')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('saving the same prepared id-less model twice reuses its assigned stable ID', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    let sequence = 0
    const library = createLive2DModelLibrary(memoryStore(), { now: () => 100, createId: () => `generated-${++sequence}` })
    const imported = model('temporary', 'Imported')
    delete imported.config.modelId

    await library.save(imported)
    await library.save(imported)

    assert.deepEqual((await library.list()).map(({ id }) => id), ['generated-1'])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('recent models are MRU ordered, deduplicated, and capped at five', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    let clock = 100
    const store = memoryStore()
    const library = createLive2DModelLibrary(store, { now: () => ++clock })

    for (let index = 1; index <= 6; index += 1) {
      await library.save(model(`model-${index}`, `Model ${index}`, index))
    }
    assert.deepEqual((await library.list()).map(({ id, active }) => [id, active]), [
      ['model-6', true],
      ['model-5', false],
      ['model-4', false],
      ['model-3', false],
      ['model-2', false],
    ])
    assert.equal(await library.loadById('model-1'), null)
    assert.equal(await library.loadById('model-2') !== null, true)
    assert.equal(store.keys().includes('model:model-1'), false)
    assert.equal(store.keys().filter((key) => key.startsWith('model:')).length, 5)

    await library.save(model('model-3', 'Model 3 updated', 33))
    const recent = await library.list()
    assert.equal(recent.length, 5)
    assert.deepEqual(recent.map(({ id }) => id), ['model-3', 'model-6', 'model-5', 'model-4', 'model-2'])
    assert.equal(recent[0].name, 'Model 3 updated')
    assert.equal((await library.load()).config.importedAt, 33)
    assert.equal(recent[0].id, 'model-3')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('activating a saved model moves it to the front and default mode preserves history', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    let clock = 10
    const library = createLive2DModelLibrary(memoryStore(), { now: () => ++clock })
    await library.save(model('a', 'Alpha'))
    await library.save(model('b', 'Beta'))

    const selected = await library.activate('a')
    assert.equal(selected, true)
    assert.deepEqual((await library.list()).map(({ id, active }) => [id, active]), [
      ['a', true],
      ['b', false],
    ])

    await library.useDefault()
    assert.equal(await library.load(), null)
    assert.deepEqual((await library.list()).map(({ id, active }) => [id, active]), [
      ['a', false],
      ['b', false],
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('serialized commit order also determines MRU timestamps', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const store = memoryStore()
    let clock = 100
    const library = createLive2DModelLibrary(store, { now: () => ++clock })

    await Promise.all([
      library.save(model('a', 'Alpha')),
      library.save(model('b', 'Beta')),
    ])

    const recent = await library.list()
    assert.deepEqual(recent.map(({ id }) => id), ['b', 'a'])
    assert.deepEqual(recent.map(({ lastUsedAt }) => lastUsedAt), [102, 101])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('concurrent saves keep both models instead of losing one read-modify-write update', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    let clock = 20
    const library = createLive2DModelLibrary(memoryStore(), { now: () => ++clock })

    await Promise.all([
      library.save(model('a', 'Alpha')),
      library.save(model('b', 'Beta')),
    ])

    const recent = await library.list()
    assert.equal(recent.length, 2)
    assert.deepEqual(new Set(recent.map(({ id }) => id)), new Set(['a', 'b']))
    assert.equal(recent.filter(({ active }) => active).length, 1)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('migration reads the latest legacy active model inside the same atomic update', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-library-test-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const oldLegacy = legacyRecord(model('old', 'Old', 1))
    const latestLegacy = legacyRecord(model('latest', 'Latest', 2))
    const store = memoryStore({ active: oldLegacy })
    const originalRead = store.read
    store.read = async (key) => {
      const value = await originalRead(key)
      if (key === 'library') store.seed('active', latestLegacy)
      return value
    }
    const library = createLive2DModelLibrary(store, { now: () => 50 })

    assert.equal((await library.load()).config.name, 'Latest')
    assert.equal(store.keys().includes('active'), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('migrating the legacy active record keeps the model and deletes the old key atomically', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const legacyModel = model('legacy-import-id', 'Legacy', 7)
    delete legacyModel.config.modelId
    const legacyRecord = {
      schemaVersion: 1,
      config: legacyModel.config,
      modelJson: legacyModel.modelJson,
      rootJsonPath: legacyModel.rootJsonPath,
      files: { 'Legacy.moc3': legacyModel.files['Legacy.moc3'].buffer },
    }
    const store = memoryStore({ active: legacyRecord })
    const library = createLive2DModelLibrary(store, { now: () => 50 })

    assert.equal((await library.load()).config.name, 'Legacy')
    assert.deepEqual((await library.list()).map(({ name, active }) => [name, active]), [['Legacy', true]])
    assert.equal(await store.read('active'), undefined)
    assert.equal((await store.read('library')).schemaVersion, 2)
    assert.equal(store.keys().some((key) => key.startsWith('model:legacy-')), true)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('oversized or mismatched manifests are rejected instead of violating the five-model invariant', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const entries = Array.from({ length: 6 }, (_, index) => ({
      id: `id-${index}`,
      lastUsedAt: index,
      config: model(`id-${index}`, `Model ${index}`).config,
    }))
    const oversized = createLive2DModelLibrary(memoryStore({ library: { schemaVersion: 2, activeModelId: 'id-0', models: entries } }))
    assert.deepEqual(await oversized.list(), [])

    entries.pop()
    entries[0].config.modelId = 'different-id'
    const mismatched = createLive2DModelLibrary(memoryStore({ library: { schemaVersion: 2, activeModelId: 'id-0', models: entries } }))
    assert.deepEqual(await mismatched.list(), [])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('malformed library data safely appears empty instead of throwing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const library = createLive2DModelLibrary(memoryStore({
      library: { schemaVersion: 2, activeModelId: 'broken', models: [{ id: 'broken', lastUsedAt: 1, model: null }] },
      active: { schemaVersion: 1, config: {}, files: null },
    }))

    assert.deepEqual(await library.list(), [])
    assert.equal(await library.load(), null)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('loading a missing active payload prunes its stale current entry', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const missing = model('missing', 'Missing')
    const store = memoryStore({
      library: {
        schemaVersion: 2,
        activeModelId: 'missing',
        models: [{ id: 'missing', lastUsedAt: 9, config: missing.config }],
      },
    })
    const library = createLive2DModelLibrary(store)

    assert.equal(await library.load(), null)
    assert.deepEqual(await library.list(), [])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('deleting one model releases it and falls back to default only when it was active', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-library-'))
  try {
    const { createLive2DModelLibrary } = await loadModule(temp)
    const store = memoryStore()
    const library = createLive2DModelLibrary(store, { now: () => 10 })
    await library.save(model('a', 'Alpha'))
    await library.save(model('b', 'Beta'))
    assert.deepEqual(await library.delete('a'), { deleted: true, wasActive: false })
    assert.equal((await library.load()).config.name, 'Beta')
    assert.deepEqual((await library.list()).map(({ id }) => id), ['b'])
    assert.equal(store.keys().includes('model:a'), false)

    assert.deepEqual(await library.delete('b'), { deleted: true, wasActive: true })
    assert.deepEqual(await library.delete('missing'), { deleted: false, wasActive: false })
    assert.equal(await library.load(), null)
    assert.deepEqual(await library.list(), [])
    assert.equal(await library.activate('missing'), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
