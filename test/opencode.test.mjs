import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')
let moduleSequence = 0

async function loadOpenCodeModule(temp) {
  const outfile = join(temp, `opencode-under-test-${++moduleSequence}.mjs`)
  await build({
    entryPoints: [join(projectRoot, 'src/host/opencode.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    external: ['node:*'],
  })
  return import(pathToFileURL(outfile).href)
}

const REAL_SAMPLE = {
  usage: {
    rolling: { status: 'ok', percent: 5, resetsAt: '2026-09-02T20:35:10.315Z' },
    weekly: { status: 'ok', percent: 2, resetsAt: '2026-09-07T00:00:00.315Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-10-02T15:32:23.315Z' },
  },
}

test('parseOpenCodeGoUsage maps the official gateway payload to used/remaining windows', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-opencode-test-'))
  try {
    const { parseOpenCodeGoUsage } = await loadOpenCodeModule(temp)
    const parsed = parseOpenCodeGoUsage(REAL_SAMPLE, 12345, 'auth')
    assert.ok(parsed !== null)
    assert.equal(parsed.configured, true)
    assert.equal(parsed.keySource, 'auth')
    assert.equal(parsed.error, null)
    assert.deepEqual(parsed.windows.rolling, {
      key: 'rolling', label: '5 小时', status: 'ok', percent: 5, remaining: 95, resetsAt: Date.parse('2026-09-02T20:35:10.315Z'),
    })
    assert.deepEqual(parsed.windows.weekly, {
      key: 'weekly', label: '7 天', status: 'ok', percent: 2, remaining: 98, resetsAt: Date.parse('2026-09-07T00:00:00.315Z'),
    })
    assert.deepEqual(parsed.windows.monthly, {
      key: 'monthly', label: '1 个月', status: 'ok', percent: 1, remaining: 99, resetsAt: Date.parse('2026-10-02T15:32:23.315Z'),
    })
    assert.equal(parseOpenCodeGoUsage(null, 1, 'auth'), null)
    assert.equal(parseOpenCodeGoUsage({ usage: 'nope' }, 1, 'auth'), null)
    assert.equal(parseOpenCodeGoUsage({ usage: {} }, 1, 'auth').windows.rolling.percent, null)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('resolveOpenCodeGoKey prefers the env var and falls back to the opencode CLI login file', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-opencode-key-test-'))
  try {
    const { resolveOpenCodeGoKey } = await loadOpenCodeModule(temp)
    const authDir = join(temp, '.local', 'share', 'opencode')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({
      deepseek: { type: 'api', key: 'sk-deepseek' },
      'opencode-go': { type: 'api', key: 'sk-go-from-cli' },
    }), 'utf8')

    assert.deepEqual(resolveOpenCodeGoKey({ OPENCODE_GO_API_KEY: 'sk-env' }, temp), { key: 'sk-env', source: 'env' })
    assert.deepEqual(resolveOpenCodeGoKey({}, temp), { key: 'sk-go-from-cli', source: 'auth' })
    assert.deepEqual(resolveOpenCodeGoKey({ OPENCODE_GO_API_KEY: '' }, temp), { key: 'sk-go-from-cli', source: 'auth' })
    assert.equal(resolveOpenCodeGoKey({}, join(temp, 'missing-home')), null)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('resolveOpenCodeGoKey prefers the key the DSH host already resolved', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-opencode-dsh-key-test-'))
  try {
    const { resolveOpenCodeGoKey } = await loadOpenCodeModule(temp)
    const authDir = join(temp, '.local', 'share', 'opencode')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({
      'opencode-go': { type: 'api', key: 'sk-go-from-cli' },
    }), 'utf8')

    // DSH 的凭证服务（`.credentials.yaml` 的 refs / `.env`）是权威来源：
    // 它拿到的就是 DSH 自己发请求用的那把密钥。
    assert.deepEqual(resolveOpenCodeGoKey({ OPENCODE_GO_API_KEY: 'sk-env' }, temp, 'oc_from_dsh'), {
      key: 'oc_from_dsh',
      source: 'dsh',
    })
    assert.deepEqual(resolveOpenCodeGoKey({}, temp, 'oc_from_dsh'), { key: 'oc_from_dsh', source: 'dsh' })
    // 空值等于没给 → 继续按环境变量、CLI 登录文件回退。
    assert.deepEqual(resolveOpenCodeGoKey({ OPENCODE_GO_API_KEY: 'sk-env' }, temp, ''), { key: 'sk-env', source: 'env' })
    assert.deepEqual(resolveOpenCodeGoKey({}, temp, null), { key: 'sk-go-from-cli', source: 'auth' })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('fetchOpenCodeGoUsage sends the DSH-resolved credential and labels its source', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-opencode-dsh-fetch-test-'))
  try {
    const { fetchOpenCodeGoUsage, resetOpenCodeGoCache } = await loadOpenCodeModule(temp)
    resetOpenCodeGoCache()

    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), authorization: init?.headers?.Authorization })
      return { ok: true, status: 200, json: async () => REAL_SAMPLE }
    }
    const usage = await fetchOpenCodeGoUsage({
      env: {},
      homeDir: temp,
      dshKey: 'oc_from_dsh',
      fetchImpl,
      cacheMs: 0,
    })

    assert.equal(usage.keySource, 'dsh')
    assert.equal(usage.error, null)
    assert.equal(usage.windows.rolling.percent, 5)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].authorization, 'Bearer oc_from_dsh')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('fetchOpenCodeGoUsage turns gateway auth failures into actionable errors', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-opencode-error-test-'))
  try {
    const { fetchOpenCodeGoUsage, resetOpenCodeGoCache } = await loadOpenCodeModule(temp)
    const expiredBody = JSON.stringify({
      error: {
        type: 'authentication_error',
        code: 'api_key_expired',
        message: 'This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store.',
      },
    })
    const base = { env: {}, homeDir: temp, dshKey: 'oc_dead', cacheMs: 0 }

    // 过期密钥：说明发生了什么，并把用户送到可以换钥匙的页面，而不是只回 "gateway 401"。
    resetOpenCodeGoCache()
    const expired = await fetchOpenCodeGoUsage({
      ...base,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => expiredBody }),
    })
    assert.equal(expired.configured, true)
    assert.equal(expired.keySource, 'dsh')
    assert.match(expired.error, /已过期/u)
    assert.match(expired.error, /opencode\.ai\/console\/account#api-keys/u)

    // 非 JSON 的 401 也要能读懂。
    resetOpenCodeGoCache()
    const bare = await fetchOpenCodeGoUsage({
      ...base,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }),
    })
    assert.match(bare.error, /凭证无效/u)
    assert.match(bare.error, /401/u)

    // 网关故障保持原样的状态码描述。
    resetOpenCodeGoCache()
    const down = await fetchOpenCodeGoUsage({
      ...base,
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => '' }),
    })
    assert.equal(down.error, 'gateway 502')

    // CLI 登录文件里的旧密钥同样过期时，要指出这把钥匙来自哪里。
    resetOpenCodeGoCache()
    const authDir = join(temp, '.local', 'share', 'opencode')
    await mkdir(authDir, { recursive: true })
    await writeFile(join(authDir, 'auth.json'), JSON.stringify({
      'opencode-go': { type: 'api', key: 'sk-go-from-cli' },
    }), 'utf8')
    const cli = await fetchOpenCodeGoUsage({
      env: {},
      homeDir: temp,
      cacheMs: 0,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => expiredBody }),
    })
    assert.equal(cli.keySource, 'auth')
    assert.match(cli.error, /opencode CLI/u)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('fetchOpenCodeGoUsage caches, coalesces, and falls back to the last good data', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-opencode-fetch-test-'))
  try {
    const { fetchOpenCodeGoUsage, resetOpenCodeGoCache } = await loadOpenCodeModule(temp)
    resetOpenCodeGoCache()

    let fetchCount = 0
    const fetchImpl = async () => {
      fetchCount += 1
      return {
        ok: true,
        status: 200,
        json: async () => REAL_SAMPLE,
      }
    }
    const env = { OPENCODE_GO_API_KEY: 'sk-test' }
    const options = { env, homeDir: temp, fetchImpl, cacheMs: 30_000 }

    const first = await fetchOpenCodeGoUsage(options)
    assert.equal(first.configured, true)
    assert.equal(fetchCount, 1)

    // 缓存期内第二次调用不重新抓取。
    const second = await fetchOpenCodeGoUsage(options)
    assert.equal(second.fetchedAt, first.fetchedAt)
    assert.equal(fetchCount, 1)

    // 刷新失败且没有成功数据 → 带错误的未配置结果。
    resetOpenCodeGoCache()
    const noCache = { ...options, cacheMs: 0 }
    const failed = await fetchOpenCodeGoUsage({ ...noCache, fetchImpl: async () => ({ ok: false, status: 502 }) })
    assert.equal(failed.configured, true)
    assert.ok(failed.error !== null)

    // 成功后再失败 → 回退到上次成功数据，仅加错误标记。
    const okUsage = await fetchOpenCodeGoUsage(noCache)
    assert.equal(okUsage.windows.rolling.percent, 5)
    const stale = await fetchOpenCodeGoUsage({ ...noCache, fetchImpl: async () => { throw new Error('network down') } })
    assert.equal(stale.windows.rolling.percent, 5)
    assert.equal(stale.error, '暂时无法刷新，显示上次数据')
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})