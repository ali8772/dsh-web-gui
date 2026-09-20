import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('priceAt uses provider-specific external prices for non-DeepSeek models', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-pricing-external-'))
  try {
    const { priceAt } = await loadModule(temp, 'src/host/pricing.ts', 'pricing-external')
    const price = priceAt('gpt-5.6-sol', Date.parse('2026-09-20T02:00:00.000Z'), {
      provider: 'codex',
      externalCatalog: {
        version: 1,
        fetchedAt: 1,
        providers: {
          codex: {
            models: {
              'gpt-5.6-sol': { usd: { input: 4, cacheRead: 0.4, output: 20 } },
            },
          },
        },
      },
    })
    assert.deepEqual(price.usd, { input: 4, cacheRead: 0.4, output: 20 })
    assert.ok(price.cny.input > 0, 'external USD prices should have a CNY display conversion')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('normalizeModelsDevCatalog keeps explicit cache-free prices and falls back missing cache prices', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-pricing-normalize-'))
  try {
    const { normalizeModelsDevCatalog } = await loadModule(temp, 'src/host/pricing-catalog.ts', 'pricing-normalize')
    const catalog = normalizeModelsDevCatalog({
      openai: { models: {
        cached: { cost: { input: 1, output: 2, cache_read: 0 } },
        uncached: { cost: { input: 3, output: 4 } },
      } },
    }, { fetchedAt: 10 })
    assert.deepEqual(catalog.providers.openai.models.cached.usd, { input: 1, cacheRead: 0, output: 2 })
    assert.deepEqual(catalog.providers.openai.models.uncached.usd, { input: 3, cacheRead: 3, output: 4 })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('pricing manager refreshes weekly and keeps the last valid catalog on failure', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-pricing-manager-'))
  try {
    const { createPricingManager, PRICING_REFRESH_MS } = await loadModule(temp, 'src/host/pricing-catalog.ts', 'pricing-manager')
    let now = Date.parse('2026-09-20T00:00:00.000Z')
    let calls = 0
    const payload = JSON.stringify({
      openai: { models: { 'gpt-5': { cost: { input: 1, output: 2, cache_read: 0.1 } } } },
    })
    const response = (body, ok = true) => new Response(body, { status: ok ? 200 : 503, headers: { 'content-type': 'application/json' } })
    const manager = createPricingManager({
      home: temp,
      now: () => now,
      fetchImpl: async () => { calls += 1; return response(payload) },
    })
    await manager.refresh()
    assert.equal(calls, 1)
    assert.deepEqual(manager.snapshot().lookup('gpt-5', now, 'openai').usd, { input: 1, cacheRead: 0.1, output: 2 })
    await manager.refresh()
    assert.equal(calls, 1, 'fresh catalog must not refetch')
    now += PRICING_REFRESH_MS + 1
    const staleSnapshot = manager.snapshot()
    await manager.refresh()
    assert.equal(calls, 2)
    assert.equal(manager.snapshot().revision, staleSnapshot.revision, 'same valid payload keeps its revision')
    await writeFile(manager.cachePath, JSON.stringify({ version: 1, fetchedAt: now, providers: {} }), 'utf8')
    const recovered = createPricingManager({ home: temp, now: () => now, fetchImpl: async () => response('{bad', false) })
    assert.deepEqual(recovered.snapshot().lookup('gpt-5', now, 'openai').usd, { input: 0, cacheRead: 0, output: 0 })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

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
