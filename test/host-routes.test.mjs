import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadHostModule(temp) {
  const credentialsStub = join(temp, 'credentials-stub.mjs')
  const outfile = join(temp, 'host-under-test.mjs')
  await writeFile(credentialsStub, "export const credentialRef = (name) => name\nexport const credentialKey = (scope, id) => `${scope}/${id}`\n", 'utf8')
  await build({
    entryPoints: [join(projectRoot, 'src/host/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    external: ['node:*'],
    plugins: [{
      name: 'test-credentials-stub',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@deepseek-ai\/dsh-credentials$/ }, () => ({ path: credentialsStub }))
      },
    }],
  })
  return import(pathToFileURL(outfile).href)
}

function makeResponse() {
  let status = 0
  let headers = {}
  let body = ''
  return {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus
      headers = nextHeaders
    },
    end(nextBody = '') { body = nextBody },
    result() { return { status, headers, body } },
  }
}

function request(method, chunks = [], headers = {}, remoteAddress = '127.0.0.1') {
  return {
    method,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    },
  }
}

async function startHarness(temp, rejection, overrides = {}) {
  const host = await loadHostModule(temp)
  const routes = new Map()
  let credentialReads = 0
  const ctx = {
    credentials: {
      current: undefined,
      async resolve() {
        credentialReads += 1
        return undefined
      },
      async readRecord() { return this.current },
      async modifyRecord(_key, mutate) {
        const next = await mutate(this.current)
        if (next !== undefined) this.current = structuredClone(next)
        return structuredClone(this.current)
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    connection: { requestRejection: () => rejection },
    effect(factory) { return factory() },
    get() { return undefined },
    logger: { warn() {} },
    ...overrides,
  }
  host.apply(ctx)
  return { routes, credentialReads: () => credentialReads }
}

test('private state data is rejected through the DSH connection seam before domain work', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, 401)
    const response = makeResponse()
    await harness.routes.get('/api/whale-pet/state').handler({ method: 'GET', headers: {} }, response)

    assert.equal(response.result().status, 401)
    assert.equal(harness.credentialReads(), 0, 'an unauthenticated request must not reach balance credentials')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('tasks route reads v3 session logs from the configured DSH home', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const sessionId = 'v3-progress'
    const sessionDir = join(temp, 'sessions', '--workspace--', sessionId)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from([
      JSON.stringify({ type: 'session', version: 3 }),
      JSON.stringify({ type: 'todo/write', data: { todos: [{ content: 'ship', status: 'in_progress' }] } }),
    ].join('\n') + '\n')))
    const harness = await startHarness(temp, undefined, { get(name) { return name === 'dshHomePath' ? () => temp : undefined } })
    const response = makeResponse()
    await harness.routes.get('/api/whale-pet/tasks').handler(
      request('POST', [JSON.stringify({ ids: [sessionId] })]),
      response,
    )
    const body = JSON.parse(response.result().body)
    assert.equal(response.result().status, 200)
    assert.equal(body.tasks[0].found, true)
    assert.equal(body.tasks[0].totalTodos, 1)
    assert.equal(body.tasks[0].pct, 0)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('tasks rejects malformed JSON with a stable 400 response', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined)
    const response = makeResponse()
    await harness.routes.get('/api/whale-pet/tasks').handler(
      request('POST', ['{"ids":[']),
      response,
    )

    assert.equal(response.result().status, 400)
    assert.deepEqual(JSON.parse(response.result().body), {
      ok: false,
      error: 'bad-json',
      message: 'request body must be valid JSON',
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('tasks rejects oversized request bodies with 413', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined)
    const response = makeResponse()
    await harness.routes.get('/api/whale-pet/tasks').handler(
      request('POST', ['x'.repeat(65 * 1024)]),
      response,
    )

    assert.equal(response.result().status, 413)
    assert.deepEqual(JSON.parse(response.result().body), {
      ok: false,
      error: 'payload-too-large',
      message: 'request body exceeds 64 KiB',
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('tasks rejects too many unique session ids but accepts duplicate ids once', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined)
    const tooMany = Array.from({ length: 33 }, (_, index) => `session-${index}`)
    const rejected = makeResponse()
    await harness.routes.get('/api/whale-pet/tasks').handler(
      request('POST', [JSON.stringify({ ids: tooMany })]),
      rejected,
    )
    assert.equal(rejected.result().status, 400)
    assert.deepEqual(JSON.parse(rejected.result().body), {
      ok: false,
      error: 'bad-request',
      message: 'ids must contain at most 32 unique session ids of at most 256 characters',
    })

    const accepted = makeResponse()
    await harness.routes.get('/api/whale-pet/tasks').handler(
      request('POST', [JSON.stringify({ ids: Array(40).fill('same-session') })]),
      accepted,
    )
    assert.equal(accepted.result().status, 200)
    assert.equal(JSON.parse(accepted.result().body).tasks.length, 1)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('tasks isolates a corrupt session log from healthy rows', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const healthyDir = join(temp, 'sessions', 'workspace', 'healthy')
    const corruptDir = join(temp, 'sessions', 'workspace', 'corrupt')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(healthyDir, { recursive: true })
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(healthyDir, 'session.jsonl'), '{"type":"todo/write","data":{"todos":[{"content":"done","status":"completed"}]}}\n')
    await writeFile(join(corruptDir, 'session.jsonl.zstd'), Buffer.from('not-zstd'))

    const harness = await startHarness(temp, undefined, {
      get(name) { return name === 'dshHomePath' ? () => temp : undefined },
    })
    const response = makeResponse()
    await harness.routes.get('/api/whale-pet/tasks').handler(
      request('POST', [JSON.stringify({ ids: ['healthy', 'corrupt'] })]),
      response,
    )

    assert.equal(response.result().status, 200)
    const body = JSON.parse(response.result().body)
    assert.equal(body.tasks[0].id, 'healthy')
    assert.equal(body.tasks[0].found, true)
    assert.deepEqual(body.tasks[1], {
      id: 'corrupt',
      found: false,
      errorCode: 'session-log-corrupt',
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('browser-authenticated companion management issues a one-time token', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined)
    const response = makeResponse()
    await harness.routes.get('/api/whale-pet/companions/issue').handler(
      request('POST', [JSON.stringify({ label: 'PowerShell' })]),
      response,
    )

    assert.equal(response.result().status, 201)
    const body = JSON.parse(response.result().body)
    assert.equal(body.ok, true)
    assert.equal(body.grant.label, 'PowerShell')
    assert.match(body.token, /^wpg1\./)

    const listed = makeResponse()
    await harness.routes.get('/api/whale-pet/companions').handler(request('GET'), listed)
    const listBody = JSON.parse(listed.result().body)
    assert.deepEqual(listBody.grants, [body.grant])
    assert.equal(JSON.stringify(listBody).includes(body.token), false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('a loopback companion bearer can read state and a revoked token is rejected', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined, {
      get(name) { return name === 'dshHomePath' ? () => temp : undefined },
    })
    const issuedResponse = makeResponse()
    await harness.routes.get('/api/whale-pet/companions/issue').handler(
      request('POST', [JSON.stringify({ label: 'Rust' })]),
      issuedResponse,
    )
    const issued = JSON.parse(issuedResponse.result().body)
    const headers = { authorization: `Bearer ${issued.token}` }

    const accepted = makeResponse()
    await harness.routes.get('/dsh-whale-pet/companion/v1/state').handler(
      request('GET', [], headers),
      accepted,
    )
    assert.equal(accepted.result().status, 200)

    const revokeResponse = makeResponse()
    await harness.routes.get('/api/whale-pet/companions/revoke').handler(
      request('POST', [JSON.stringify({ id: issued.grant.id })]),
      revokeResponse,
    )
    assert.equal(revokeResponse.result().status, 200)

    const rejected = makeResponse()
    await harness.routes.get('/dsh-whale-pet/companion/v1/state').handler(
      request('GET', [], headers),
      rejected,
    )
    assert.equal(rejected.result().status, 401)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('companion routes reject DNS-rebinding and cross-site browser headers before Bearer verification', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined)
    const issuedResponse = makeResponse()
    await harness.routes.get('/api/whale-pet/companions/issue').handler(
      request('POST', [JSON.stringify({ label: 'Rust' })]),
      issuedResponse,
    )
    const { token } = JSON.parse(issuedResponse.result().body)
    for (const headers of [
      { authorization: `Bearer ${token}`, host: 'attacker.example' },
      { authorization: `Bearer ${token}`, host: '127.0.0.1:3080', origin: 'https://attacker.example' },
      { authorization: `Bearer ${token}`, host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    ]) {
      const response = makeResponse()
      await harness.routes.get('/dsh-whale-pet/companion/v1/state').handler(request('GET', [], headers), response)
      assert.equal(response.result().status, 403)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('companion routes authenticate before revealing allowed methods', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined)
    const response = makeResponse()
    await harness.routes.get('/dsh-whale-pet/companion/v1/state').handler(
      request('POST', []),
      response,
    )
    assert.equal(response.result().status, 401)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('corrupt companion credential storage returns a stable 500 response', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const credentials = {
      async resolve() { return undefined },
      async readRecord() { return { kind: 'grant', payload: { v: 999 } } },
      async modifyRecord() { throw new Error('unused') },
    }
    const harness = await startHarness(temp, undefined, { credentials })
    const response = makeResponse()
    await harness.routes.get('/dsh-whale-pet/companion/v1/state').handler(
      request('GET', [], { authorization: 'Bearer wpg1.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
      response,
    )
    assert.equal(response.result().status, 500)
    assert.deepEqual(JSON.parse(response.result().body), {
      ok: false,
      error: 'internal',
      message: 'internal error',
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('companion bearer serves every data capability but never accepts a non-loopback peer', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, undefined, {
      get(name) { return name === 'dshHomePath' ? () => temp : undefined },
    })
    const issuedResponse = makeResponse()
    await harness.routes.get('/api/whale-pet/companions/issue').handler(
      request('POST', [JSON.stringify({ label: 'PowerShell' })]),
      issuedResponse,
    )
    const { token } = JSON.parse(issuedResponse.result().body)
    const headers = { authorization: `Bearer ${token}` }
    const cases = [
      ['/dsh-whale-pet/companion/v1/tasks', 'POST', { ids: [] }],
      ['/dsh-whale-pet/companion/v1/task-summary', 'POST', { id: 'missing' }],
      ['/dsh-whale-pet/companion/v1/opencode-go', 'GET', undefined],
    ]
    for (const [path, method, body] of cases) {
      const accepted = makeResponse()
      const chunks = body === undefined ? [] : [JSON.stringify(body)]
      await harness.routes.get(path).handler(request(method, chunks, headers), accepted)
      assert.equal(accepted.result().status, 200, path)

      const forbidden = makeResponse()
      await harness.routes.get(path).handler(request(method, chunks, headers, '192.168.1.8'), forbidden)
      assert.equal(forbidden.result().status, 403, path)
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('every private data route rejects untrusted requests before reading bodies or domain state', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-routes-test-'))
  try {
    const harness = await startHarness(temp, 403)
    const cases = [
      ['/api/whale-pet/state', 'GET'],
      ['/api/whale-pet/tasks', 'POST'],
      ['/api/whale-pet/task-summary', 'POST'],
      ['/api/whale-pet/opencode-go', 'GET'],
    ]
    for (const [path, method] of cases) {
      let bodyRead = false
      const request = {
        method,
        headers: {},
        async *[Symbol.asyncIterator]() {
          bodyRead = true
          yield Buffer.from('{}')
        },
      }
      const response = makeResponse()
      await harness.routes.get(path).handler(request, response)
      assert.equal(response.result().status, 403, path)
      assert.equal(bodyRead, false, `${path} must reject before consuming a request body`)
    }
    assert.equal(harness.credentialReads(), 0)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
