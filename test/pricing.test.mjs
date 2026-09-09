import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadModule(temp, entry, name) {
  const outfile = join(temp, `${name}-under-test.mjs`)
  await build({
    entryPoints: [join(projectRoot, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    external: ['node:*'],
  })
  return import(pathToFileURL(outfile).href)
}

function line(type, data, time) {
  return `${JSON.stringify({ type, data, ...(time === undefined ? {} : { time }) })}\n`
}

const pricedAt = Date.parse('2025-06-01T02:00:00.000Z')
const zeroUnit = { input: 0, cacheRead: 0, output: 0 }

test('priceAt leaves unknown and non-DeepSeek models unpriced', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-pricing-'))
  try {
    const { priceAt } = await loadModule(temp, 'src/host/pricing.ts', 'pricing')
    for (const model of ['unknown', 'gpt-5', 'claude-sonnet-4']) {
      const price = priceAt(model, pricedAt)
      assert.deepEqual(price.cny, zeroUnit)
      assert.deepEqual(price.usd, zeroUnit)
    }
    assert.deepEqual(priceAt('deepseek-chat', pricedAt).cny, { input: 2, cacheRead: 0.5, output: 8 })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('replayLogContent does not apply official prices to a DeepSeek-named model on another provider', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-provider-pricing-test-'))
  try {
    const [{ replayLogContent }, { priceAt }] = await Promise.all([
      loadModule(temp, 'src/host/sessions.ts', 'sessions-provider'),
      loadModule(temp, 'src/host/pricing.ts', 'pricing-provider'),
    ])
    const content = line('assistant/message', {
      message: { source: { kind: 'model', provider: 'openai', model: 'deepseek-chat' } },
      usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 100_000 },
    }, Date.parse('2025-06-01T02:00:00.000Z'))

    const events = replayLogContent(content, priceAt)
    assert.equal(events.length, 1)
    assert.equal(events[0].provider, 'openai')
    assert.equal(events[0].model, 'deepseek-chat')
    assert.equal(events[0].inputTokens, 1_000_000)
    assert.equal(events[0].cost, 0)
    assert.equal(events[0].costUsd, 0)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('replayLogContent uses each assistant message model and retains unknown usage at zero cost', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-pricing-replay-'))
  try {
    const [{ replayLogContent }, { priceAt }] = await Promise.all([
      loadModule(temp, 'src/host/sessions.ts', 'sessions'),
      loadModule(temp, 'src/host/pricing.ts', 'pricing'),
    ])
    const content = [
      line('assistant/message', {
        message: { source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-reasoner' } },
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      }, pricedAt),
      line('assistant/message', {
        message: { source: { kind: 'model', provider: 'openai', model: 'gpt-5' } },
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      }, pricedAt),
    ].join('')

    const events = replayLogContent(content, priceAt)
    assert.deepEqual(events.map(({ model, inputTokens, cost }) => ({ model, inputTokens, cost })), [
      { model: 'deepseek-reasoner', inputTokens: 1_000_000, cost: 4 },
      { model: 'gpt-5', inputTokens: 1_000_000, cost: 0 },
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
