import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
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

function loadSessionsModule(temp) {
  return loadModule(temp, 'src/host/sessions.ts', 'sessions')
}

function loadTasksModule(temp) {
  return loadModule(temp, 'src/host/tasks.ts', 'tasks')
}

function line(type, data) {
  return `${JSON.stringify({ type, data })}\n`
}

function checkedFrame(text) {
  return zstdCompressSync(Buffer.from(text), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

function deterministicNoise(length) {
  let state = 0x12345678
  let output = ''
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    output += String.fromCharCode(33 + (state % 90))
  }
  return output
}

function recoverablePrefix(frame, accepts) {
  const candidateEnds = [
    frame.length - 1,
    frame.length - 4,
    ...Array.from({ length: 99 }, (_, index) => Math.floor(frame.length * (0.99 - index * 0.01))),
  ]
  for (const end of candidateEnds) {
    const candidate = frame.subarray(0, end)
    try {
      const decoded = zstdDecompressSync(candidate, { finishFlush: constants.ZSTD_e_flush }).toString('utf8')
      if (accepts(decoded)) return candidate
    } catch {
      // Try a later structural cut that has emitted enough plaintext.
    }
  }
  throw new Error('test fixture could not produce the requested recoverable prefix')
}

test('readLogContent rejects checksum corruption in a structurally complete Zstandard frame', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-checksum-zstd-'))
  try {
    const logPath = join(temp, 'session.jsonl.zstd')
    const frame = checkedFrame(line('turn/start', { turn: 1 }))
    frame[frame.length - 1] ^= 0xff
    await writeFile(logPath, frame)

    const { readLogContent } = await loadSessionsModule(temp)
    assert.throws(
      () => readLogContent({ id: 'checksum-corrupt', path: logPath }),
      /corrupt Zstandard session log: failed to decompress complete frame/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('readLogContent rejects structural Zstandard corruption instead of treating it as clean EOF', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-corrupt-zstd-'))
  try {
    const logPath = join(temp, 'session.jsonl.zstd')
    await writeFile(logPath, Buffer.concat([
      checkedFrame(line('turn/start', { turn: 1 })),
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    ]))
    const { readLogContent } = await loadSessionsModule(temp)
    assert.throws(
      () => readLogContent({ id: 'corrupt', path: logPath }),
      /corrupt Zstandard session log: invalid frame magic/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('listSessionLogs discovers versioned v3 session artifacts and prefers them over legacy duplicates', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-session-artifacts-'))
  try {
    const { listSessionLogs } = await loadSessionsModule(temp)
    const workspace = join(temp, 'sessions', '--workspace--', 'same-id')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'session.jsonl.zstd'), checkedFrame(line('session', { version: 2 })))
    await writeFile(join(workspace, 'session.v3.jsonl.zstd'), checkedFrame(line('session', { version: 3 })))
    const logs = listSessionLogs(temp)
    assert.deepEqual(logs.map(({ id, path }) => ({ id, name: basename(path) })), [{ id: 'same-id', name: 'session.v3.jsonl.zstd' }])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('progressForSession rejects checksum corruption in a newly appended complete frame', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-progress-checksum-'))
  try {
    const sessionId = 'checksum-progress'
    const logPath = join(temp, 'session.jsonl.zstd')
    await writeFile(logPath, checkedFrame(line('turn/start', { turn: 1 })))
    const { progressForSession } = await loadTasksModule(temp)
    const index = new Map([[sessionId, { id: sessionId, path: logPath }]])
    assert.equal(progressForSession(index, sessionId).turn, 1)

    const corrupt = checkedFrame(line('turn/start', { turn: 2 }))
    corrupt[corrupt.length - 1] ^= 0xff
    await appendFile(logPath, corrupt)
    assert.throws(
      () => progressForSession(index, sessionId),
      /corrupt Zstandard session log: failed to decompress complete frame/,
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('progressForSession does not replay a recovered torn-frame event when that frame grows', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-progress-growing-tail-'))
  try {
    const sessionId = 'growing-tail-progress'
    const logPath = join(temp, 'session.jsonl.zstd')
    const first = line('tool/call', {
      turn: 1,
      step: 1,
      name: 'ask_user_question',
    })
    const filler = line('assistant/message', {
      message: deterministicNoise(300_000),
    })
    const second = line('tool/call', { turn: 1, step: 2, name: 'bash' })
    const completeTail = checkedFrame(first + filler + second)
    const partialTail = recoverablePrefix(
      completeTail,
      (decoded) => decoded.includes(first) && !decoded.includes(second),
    )
    await writeFile(logPath, Buffer.concat([
      checkedFrame(line('turn/start', { turn: 1 })),
      partialTail,
    ]))

    const { progressForSession } = await loadTasksModule(temp)
    const index = new Map([[sessionId, { id: sessionId, path: logPath }]])
    assert.equal(progressForSession(index, sessionId).awaitingUser, true)
    const nextEnd = Math.min(partialTail.length + 1, completeTail.length - 1)
    await appendFile(logPath, completeTail.subarray(partialTail.length, nextEnd))
    assert.equal(
      progressForSession(index, sessionId).awaitingUser,
      true,
      'growing the same torn frame must replay its recovered prefix from the committed checkpoint',
    )

    await appendFile(logPath, completeTail.subarray(nextEnd))
    const progress = progressForSession(index, sessionId)
    assert.deepEqual(
      { awaitingUser: progress.awaitingUser, stage: progress.stage, tool: progress.tool, step: progress.step },
      { awaitingUser: false, stage: 'tool', tool: 'bash', step: 2 },
      'the now-complete frame is applied once from a clean baseline rather than replaying the recovered ask tool after the later tool',
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('progressForSession processes an ordinary newly appended complete frame exactly once', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-progress-appended-frame-'))
  try {
    const sessionId = 'appended-frame-progress'
    const logPath = join(temp, 'session.jsonl.zstd')
    await writeFile(logPath, checkedFrame(line('tool/call', {
      turn: 1,
      step: 1,
      name: 'ask_user_question',
    })))
    const { progressForSession } = await loadTasksModule(temp)
    const index = new Map([[sessionId, { id: sessionId, path: logPath }]])
    assert.equal(progressForSession(index, sessionId).awaitingUser, true)

    await appendFile(logPath, checkedFrame(line('tool/call', {
      turn: 1,
      step: 2,
      name: 'bash',
    })))
    const progress = progressForSession(index, sessionId)
    assert.deepEqual(
      { awaitingUser: progress.awaitingUser, tool: progress.tool, step: progress.step },
      { awaitingUser: false, tool: 'bash', step: 2 },
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('progressForSession recovers todo state from a torn final Zstandard frame', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-progress-recovery-'))
  try {
    const sessionId = 'recover-progress'
    const logPath = join(temp, 'session.jsonl.zstd')
    const recovered = line('todo/write', {
      todos: [
        { content: 'already done', status: 'completed' },
        { content: 'recover this task', status: 'in_progress' },
      ],
    })
    const tornFrame = checkedFrame(recovered + '{"type":"todo/write"')
    await writeFile(logPath, Buffer.concat([
      checkedFrame(line('turn/start', { turn: 1 })),
      tornFrame.subarray(0, -1),
    ]))

    const { progressForSession } = await loadTasksModule(temp)
    const progress = progressForSession(new Map([[sessionId, { id: sessionId, path: logPath }]]), sessionId)
    assert.deepEqual(
      { total: progress.totalTodos, done: progress.doneTodos, current: progress.currentTodo, pct: progress.pct },
      { total: 2, done: 1, current: 'recover this task', pct: 50 },
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('readLogContent recovers a complete JSONL record when the first Zstandard frame is torn', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-first-frame-recovery-'))
  try {
    const logPath = join(temp, 'session.jsonl.zstd')
    const recovered = line('todo/write', { todos: [{ content: 'first frame record', status: 'in_progress' }] })
    const incomplete = line('assistant/message', { message: deterministicNoise(300_000) })
    const frame = checkedFrame(recovered + incomplete)
    const prefix = recoverablePrefix(frame, (decoded) => decoded.includes(recovered) && !decoded.includes(incomplete))
    await writeFile(logPath, prefix)

    const { readLogContent } = await loadSessionsModule(temp)
    assert.equal(readLogContent({ id: 'first-torn', path: logPath }), recovered)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('readLogContent recovers complete JSONL records from a torn final Zstandard frame', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-session-recovery-'))
  try {
    const logPath = join(temp, 'session.jsonl.zstd')
    const committed = line('request/header', { header: { config: { model: 'deepseek-chat' } } })
    const recovered = line('assistant/message', {
      usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 3 },
    })
    const incomplete = '{"type":"assistant/message","data":{"marker":"must-not-leak"}'
    const tornFrame = checkedFrame(recovered + incomplete)
    await writeFile(logPath, Buffer.concat([
      checkedFrame(committed),
      tornFrame.subarray(0, -1),
    ]))

    const { readLogContent } = await loadSessionsModule(temp)
    assert.equal(
      readLogContent({ id: 'recover-me', path: logPath }),
      committed + recovered,
      'the committed line in the torn frame is visible, while its partial final line is discarded',
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
