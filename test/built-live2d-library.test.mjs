import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')

async function buildClient(outfile) {
  await build({
    entryPoints: [resolve(root, 'src/client/index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'chrome100',
    outfile,
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
    loader: { '.css': 'text', '.png': 'dataurl' },
    jsx: 'automatic',
    logLevel: 'silent',
  })
}

test('published client bundle contains the recent-model library and final concurrency policy', async () => {
  const built = await readFile(resolve(root, 'lib/client.js'), 'utf8')
  assert.match(built, /MAX_RECENT_LIVE2D_MODELS = 5/)
  assert.match(built, /MODEL_KEY_PREFIX = "model:"/)
  assert.match(built, /recentLive2dModels/)
  assert.match(built, /wp-live2d-recent-label/)
  assert.match(built, /readRelated/)
  assert.match(built, /live2dPreparationRef/)
  assert.doesNotMatch(built, /restoreActiveStoredModel/)
})

test('published client bundle matches a clean build from current source', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-built-client-'))
  try {
    const rawPath = join(temp, 'client-raw.js')
    await buildClient(rawPath)
    const raw = await readFile(rawPath, 'utf8')
    const expected = `window.__ModuleLoader__.load({ id: 'dsh-whale-pet', factory: (require) => {\n`
      + `var module = { exports: {} };\nvar exports = module.exports;\n`
      + raw
      + `\nreturn module.exports;\n} });\n`
    assert.equal(await readFile(resolve(root, 'lib/client.js'), 'utf8'), expected)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
