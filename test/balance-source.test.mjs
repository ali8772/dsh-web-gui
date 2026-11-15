import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  let body = ''
  return {
    writeHead(nextStatus) { status = nextStatus },
    end(nextBody = '') { body = nextBody },
    result() { return { status, body: body === '' ? undefined : JSON.parse(body) } },
  }
}

async function startHarness(temp, { account, credential } = {}) {
  const originalFetch = globalThis.fetch
  const { apply } = await loadHostModule(temp)
  const routes = new Map()
  let credentialReads = 0
  const ctx = {
    credentials: {
      async resolve() {
        credentialReads += 1
        return credential
      },
      async readRecord() { return undefined },
      async modifyRecord(_key, mutate) { return mutate(undefined) },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    effect(factory) { return factory() },
    get(name) {
      if (name === 'dshHomePath') return () => temp
      if (name === 'deepseekAccount') return account
      return undefined
    },
    logger: { warn() {} },
  }
  apply(ctx)
  globalThis.fetch = async (input) => {
    if (String(input).includes('models.dev')) return { ok: false, status: 503, json: async () => ({}) }
    return {
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: 6.5, granted_balance: 1.5, topped_up_balance: 5 }],
      }),
    }
  }
  return {
    async state() {
      const response = makeResponse()
      await routes.get('/api/whale-pet/state').handler({ method: 'GET', headers: {} }, response)
      return response.result()
    },
    credentialReads: () => credentialReads,
    restore() { globalThis.fetch = originalFetch },
  }
}

test('state uses the signed-in DeepSeek account wallet when no API key is configured', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-account-balance-'))
  let calls = 0
  const harness = await startHarness(temp, {
    account: {
      async getBalance(client) {
        calls += 1
        assert.equal(typeof client.version, 'string')
        assert.equal(typeof client.locale, 'string')
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '12.34' }],
          bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
        }
      },
    },
  })
  try {
    const result = await harness.state()
    assert.equal(result.status, 200)
    assert.equal(result.body.balance.available, true)
    assert.equal(result.body.balance.currency, 'CNY')
    assert.equal(result.body.balance.totalBalance, 17.34)
    assert.equal(result.body.balance.toppedUpBalance, 12.34)
    assert.equal(result.body.balance.grantedBalance, 5)
    assert.equal(calls, 1)
    assert.equal(harness.credentialReads(), 0, 'the account wallet must not require an API key')
  } finally {
    harness.restore()
    await rm(temp, { recursive: true, force: true })
  }
})

test('state falls back to the API key balance when the account service is unavailable', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-account-fallback-'))
  const harness = await startHarness(temp, { credential: { value: '<TEST_KEY>' } })
  try {
    const result = await harness.state()
    assert.equal(result.status, 200)
    assert.equal(result.body.balance.totalBalance, 6.5)
    assert.equal(result.body.balance.grantedBalance, 1.5)
    assert.equal(harness.credentialReads(), 1)
  } finally {
    harness.restore()
    await rm(temp, { recursive: true, force: true })
  }
})

test('state ignores a failed or signed-out account read and keeps the API key fallback', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-account-failed-'))
  const harness = await startHarness(temp, {
    account: { async getBalance() { return { status: 'failed' } } },
    credential: { value: '<TEST_KEY>' },
  })
  try {
    const result = await harness.state()
    assert.equal(result.status, 200)
    assert.equal(result.body.balance.totalBalance, 6.5)
    assert.equal(harness.credentialReads(), 1)
  } finally {
    harness.restore()
    await rm(temp, { recursive: true, force: true })
  }
})

test('a throwing account read never fails the state route', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-account-throws-'))
  const harness = await startHarness(temp, {
    account: { async getBalance() { throw new Error('platform unreachable') } },
    credential: { value: '<TEST_KEY>' },
  })
  try {
    const result = await harness.state()
    assert.equal(result.status, 200)
    assert.equal(result.body.balance.totalBalance, 6.5)
  } finally {
    harness.restore()
    await rm(temp, { recursive: true, force: true })
  }
})
