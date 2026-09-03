import assert from 'node:assert/strict'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')
let moduleSequence = 0

async function loadTasksModule(temp) {
  const outfile = join(temp, `tasks-under-test-${++moduleSequence}.mjs`)
  await build({
    entryPoints: [join(projectRoot, 'src/host/tasks.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    external: ['node:*'],
  })
  return import(pathToFileURL(outfile).href)
}

function line(type, data, time) {
  return `${JSON.stringify({ type, data, ...(time === undefined ? {} : { time }) })}\n`
}

test('sessionSummary separates the latest conversation from full-session usage', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-summary-test-'))
  try {
    const sessionId = 'summary-session'
    const logPath = join(temp, 'session.jsonl')
    const { sessionSummary } = await loadTasksModule(temp)
    const logIndex = new Map([[sessionId, { id: sessionId, path: logPath }]])
    const content = [
      line('request/header', { header: { config: { model: 'deepseek-reasoner' } } }),
      line('user/message', { message: 'first turn' }),
      line('assistant/message', { usage: { inputTokens: 1_000_000, cacheReadTokens: 200_000, outputTokens: 300_000 } }),
      line('user/message', { message: 'latest turn' }),
      line('assistant/message', { usage: { inputTokens: 400_000, cacheReadTokens: 100_000, outputTokens: 150_000 } }),
      line('assistant/message', { usage: { inputTokens: 50_000, cacheReadTokens: 20_000, outputTokens: 30_000 } }),
    ].join('')
    await writeFile(logPath, content, 'utf8')

    const summary = sessionSummary(logIndex, sessionId)
    assert.equal(summary.found, true)
    assert.equal(summary.model, 'deepseek-reasoner')
    assert.deepEqual(
      {
        calls: summary.calls,
        input: summary.inputTokens,
        cacheRead: summary.cacheReadTokens,
        output: summary.outputTokens,
      },
      { calls: 2, input: 450_000, cacheRead: 120_000, output: 180_000 },
      'current conversation includes only assistant usage after the latest user/message',
    )
    assert.deepEqual(
      {
        calls: summary.totalCalls,
        input: summary.totalInputTokens,
        cacheRead: summary.totalCacheReadTokens,
        output: summary.totalOutputTokens,
      },
      { calls: 3, input: 1_450_000, cacheRead: 320_000, output: 480_000 },
      'conversation total includes every assistant usage in the session',
    )
    assert.ok(summary.cost > 0 && summary.totalCost > summary.cost)
    // deepseek-reasoner 标准价：未缓存输入 ¥4/M、缓存输入 ¥1/M、输出 ¥16/M。
    assert.equal(summary.cost, 4.8, 'latest-turn cost must inherit the model selected before its user/message boundary')
    assert.equal(summary.totalCost, 13.8)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('sessionSummary prices mixed-model usage per model instead of using the last model', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-mixed-model-test-'))
  try {
    const sessionId = 'mixed-model-session'
    const logPath = join(temp, 'session.jsonl')
    const { sessionSummary } = await loadTasksModule(temp)
    const logIndex = new Map([[sessionId, { id: sessionId, path: logPath }]])
    const pricedAt = Date.parse('2026-06-01T02:00:00.000Z')
    const content = [
      line('request/header', { header: { config: { model: 'deepseek-reasoner' } } }),
      line('user/message', { message: 'first turn' }),
      line('assistant/message', { usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 } }, pricedAt),
      line('user/message', { message: 'latest turn' }),
      line('request/header', { header: { config: { model: 'deepseek-v4-flash' } } }),
      line('assistant/message', { usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 } }, pricedAt),
      line('request/header', { header: { config: { model: 'deepseek-v4-pro' } } }),
      line('assistant/message', { usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 } }, pricedAt),
    ].join('')
    await writeFile(logPath, content, 'utf8')

    const summary = sessionSummary(logIndex, sessionId)
    assert.equal(summary.cost, 4, 'latest turn should sum Flash ¥1 + Pro ¥3')
    assert.equal(summary.totalCost, 8, 'session should also include Reasoner ¥4')
    assert.deepEqual(summary.models, [
      { model: 'deepseek-v4-flash', calls: 1, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, cost: 1, costUsd: 0.14 },
      { model: 'deepseek-v4-pro', calls: 1, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, cost: 3, costUsd: 0.435 },
    ])
    assert.deepEqual(summary.totalModels, [
      { model: 'deepseek-reasoner', calls: 1, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, cost: 4, costUsd: 0.55 },
      { model: 'deepseek-v4-flash', calls: 1, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, cost: 1, costUsd: 0.14 },
      { model: 'deepseek-v4-pro', calls: 1, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0, cost: 3, costUsd: 0.435 },
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('approval/decided clears awaitingUser before any later agent event', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-progress-test-'))
  try {
    const sessionId = 'approval-transition-session'
    const logPath = join(temp, 'session.jsonl.zstd')
    const { progressForSession } = await loadTasksModule(temp)
    const logIndex = new Map([[sessionId, { id: sessionId, path: logPath }]])

    await writeFile(logPath, zstdCompressSync(Buffer.from(line('approval/asked', {
      id: 'approval-1',
      toolName: 'bash',
    }), 'utf8')))
    assert.equal(
      progressForSession(logIndex, sessionId).awaitingUser,
      true,
      'an open approval must turn the task indicator yellow',
    )

    await appendFile(logPath, zstdCompressSync(Buffer.from(line('approval/decided', {
      id: 'approval-1',
      outcome: 'allowed-once',
    }), 'utf8')))
    assert.equal(
      progressForSession(logIndex, sessionId).awaitingUser,
      false,
      'the approval decision itself must clear the yellow indicator',
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
