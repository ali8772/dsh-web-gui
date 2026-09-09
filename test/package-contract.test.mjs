import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')

async function text(path) {
  return readFile(resolve(projectRoot, path), 'utf8')
}

test('TypeScript typecheck is a required local, pack, and CI quality gate', async () => {
  const [manifestText, ci, release] = await Promise.all([
    text('package.json'),
    text('.github/workflows/ci.yml'),
    text('.github/workflows/release.yml'),
  ])
  const manifest = JSON.parse(manifestText)

  assert.equal(manifest.scripts?.typecheck, 'tsc --noEmit')
  assert.match(manifest.scripts?.['pack:plugin'] ?? '', /npm run typecheck/)
  assert.match(ci, /npm run typecheck/)
  assert.match(release, /npm run typecheck/)
})

test('bundle budgets and dependency audit are required local and CI gates', async () => {
  const [manifestText, ci, release] = await Promise.all([
    text('package.json'),
    text('.github/workflows/ci.yml'),
    text('.github/workflows/release.yml'),
  ])
  const manifest = JSON.parse(manifestText)
  assert.match(manifest.scripts?.['check:size'] ?? '', /bundle-budget\.mjs/)
  assert.match(manifest.scripts?.['audit:prod'] ?? '', /audit-production\.mjs/)
  for (const workflow of [ci, release]) {
    assert.match(workflow, /npm run check:size/)
    assert.match(workflow, /npm run audit:prod/)
  }
  assert.equal(manifest.files.includes('lib/live2d-zip-worker.js'), true)
})

test('plugin manifest requests every host service used by the entry point', async () => {
  const [pluginText, host] = await Promise.all([
    text('dsh.plugin.json'),
    text('src/host/index.ts'),
  ])
  const plugin = JSON.parse(pluginText)
  const expected = ['credentials', 'webServer', 'connection']
  assert.deepEqual(plugin.entry?.inject, expected)
  assert.match(host, /export const inject = \['credentials', 'webServer', 'connection'\]/)
})

test('immutable runtime assets use long-lived cache headers while private data remains no-store', async () => {
  const host = await text('src/host/index.ts')
  assert.match(host, /const IMMUTABLE_JS_HEADERS = \{[\s\S]*?'cache-control': 'public, max-age=31536000, immutable'/)
  for (const route of ['live2d', 'live2dZipWorker', 'cubismCore']) {
    assert.match(host, new RegExp(`WHALE_PET_PATHS\\.${route}[\\s\\S]*?writeHead\\(200, IMMUTABLE_JS_HEADERS\\)`))
  }
  assert.match(host, /const JSON_HEADERS = \{[\s\S]*?'cache-control': 'no-store'/)
})

test('CI validates source-only Rust and PowerShell companion changes', async () => {
  const [ci, release] = await Promise.all([
    text('.github/workflows/ci.yml'),
    text('.github/workflows/release.yml'),
  ])
  for (const workflow of [ci, release]) {
    assert.match(workflow, /cargo fmt --manifest-path windows-rust\/Cargo\.toml --check/)
    assert.match(workflow, /cargo test --manifest-path windows-rust\/Cargo\.toml --locked/)
    assert.match(workflow, /cargo clippy --manifest-path windows-rust\/Cargo\.toml --locked -- -D warnings/)
    assert.match(workflow, /companion-client\.test\.mjs/)
  }
})

test('published runtime contract consistently requires Node.js 24 or newer', async () => {
  const [manifestText, lockText, build, ci, release, ...docs] = await Promise.all([
    text('package.json'),
    text('package-lock.json'),
    text('build.mjs'),
    text('.github/workflows/ci.yml'),
    text('.github/workflows/release.yml'),
    text('README.md'),
    text('README.en.md'),
    text('CONTRIBUTING.md'),
    text('docs/INSTALL.md'),
    text('test/balance-spend.test.mjs'),
    text('test/live2d.test.mjs'),
    text('test/opencode.test.mjs'),
    text('test/tasks-progress.test.mjs'),
  ])
  const manifest = JSON.parse(manifestText)
  const lock = JSON.parse(lockText)

  assert.equal(manifest.engines?.node, '>=24')
  assert.equal(lock.packages?.['']?.engines?.node, '>=24')
  assert.doesNotMatch(lockText, /registry\.npmmirror\.com/, 'lockfile must remain portable across npm registries')
  assert.match(build, /target:\s*['"]node24['"]/)
  assert.match(ci, /node-version:\s*24/)
  assert.match(release, /node-version:\s*24/)
  for (const document of docs) {
    assert.doesNotMatch(document, /Node\.js 20\+/)
    assert.doesNotMatch(document, /target:\s*['"]node20['"]/)
  }
})
