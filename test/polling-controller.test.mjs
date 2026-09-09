import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadController(temp) {
  const outfile = join(temp, 'polling-controller.mjs')
  await build({
    entryPoints: [join(projectRoot, 'src/client/polling-controller.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    external: ['node:*'],
  })
  return import(pathToFileURL(outfile).href)
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('polling coalesces overlapping triggers and never lets a stale response overwrite the latest run', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-poll-test-'))
  try {
    const { createPollingController } = await loadController(temp)
    const first = deferred()
    const second = deferred()
    const commits = []
    let calls = 0
    const polling = createPollingController({
      poll: async () => (++calls === 1 ? first.promise : second.promise),
      commit: (value) => commits.push(value),
    })

    const run = polling.trigger()
    assert.equal(polling.trigger(), run)
    assert.equal(calls, 1)
    first.resolve('old')
    await run
    const nextRun = polling.trigger()
    second.resolve('new')
    await nextRun
    assert.deepEqual(commits, ['old', 'new'])
    polling.dispose()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('disposing polling aborts the in-flight request and suppresses its late commit', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-poll-test-'))
  try {
    const { createPollingController } = await loadController(temp)
    const response = deferred()
    const commits = []
    let aborted = false
    const polling = createPollingController({
      poll: async (signal) => {
        signal.addEventListener('abort', () => { aborted = true })
        return response.promise
      },
      commit: (value) => commits.push(value),
    })
    const run = polling.trigger()
    polling.dispose()
    response.resolve('late')
    await run
    assert.equal(aborted, true)
    assert.deepEqual(commits, [])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
