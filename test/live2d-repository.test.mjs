import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadModule(temp) {
  const outfile = join(temp, 'repository.mjs')
  await build({
    entryPoints: [join(projectRoot, 'src/client/live2d/repository.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome100',
    outfile,
  })
  return import(pathToFileURL(outfile).href)
}

test('Live2DRepository rejects legacy or malformed records instead of throwing during restore', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-repo-'))
  try {
    const { createLive2DRepository } = await loadModule(temp)
    for (const active of [
      { schemaVersion: 1, kind: 'zip', name: 'legacy config only' },
      { schemaVersion: 1, config: {}, rootJsonPath: '', modelJson: {}, files: null },
      { schemaVersion: 1, config: {}, rootJsonPath: 'x.model3.json', modelJson: {}, files: { x: 'not bytes' } },
    ]) {
      const repository = createLive2DRepository({
        read: async () => active,
        write: async () => {},
        clear: async () => {},
      })
      assert.equal(await repository.load(), null)
      assert.equal(await repository.config(), null)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('Live2DRepository commits, reads, and clears one atomic active record without localStorage', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-repo-'))
  try {
    const { createLive2DRepository } = await loadModule(temp)
    let active
    const repository = createLive2DRepository({
      read: async () => active,
      write: async (record) => { active = structuredClone(record) },
      clear: async () => { active = undefined },
    })
    const model = {
      config: { kind: 'zip', name: 'Atomic', rootJsonPath: 'Atomic.model3.json', importedAt: 1, schemaVersion: 1 },
      modelJson: { Version: 3 },
      rootJsonPath: 'Atomic.model3.json',
      files: { 'Atomic.moc3': new Uint8Array([1, 2, 3]) },
    }
    await repository.save(model)
    assert.deepEqual((await repository.load()).config, model.config)
    assert.deepEqual(await repository.config(), model.config)
    await repository.remove()
    assert.equal(await repository.load(), null)
    assert.equal(await repository.config(), null)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
