import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadModule(temp) {
  const outfile = join(temp, 'session-projection.mjs')
  await build({
    entryPoints: [join(projectRoot, 'src/host/session-projection.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    external: ['node:*'],
  })
  return import(pathToFileURL(outfile).href)
}

test('SessionProjection shares a TTL index and bounds homes and entries', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-projection-test-'))
  try {
    const { createSessionProjection } = await loadModule(temp)
    let now = 0
    const scans = new Map()
    const projection = createSessionProjection({
      ttlMs: 100,
      maxHomes: 2,
      maxEntries: 3,
      now: () => now,
      scan: (home) => {
        scans.set(home, (scans.get(home) ?? 0) + 1)
        return [1, 2].map((n) => ({ id: `${home}-${n}`, path: `/${home}/${n}` }))
      },
    })

    assert.equal(projection.index('a'), projection.index('a'))
    assert.equal(scans.get('a'), 1)
    projection.index('b')
    projection.index('c')
    assert.equal(projection.stats().homes <= 2, true)
    assert.equal(projection.stats().entries <= 3, true)
    now = 101
    projection.index('c')
    assert.equal(scans.get('c'), 2)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
