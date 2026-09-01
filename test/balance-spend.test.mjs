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
  await writeFile(credentialsStub, "export const credentialRef = (name) => name\n", 'utf8')
  await build({
    entryPoints: [join(projectRoot, 'src/host/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    external: ['node:*'],
    plugins: [{
      name: 'test-credentials-stub',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@deepseek-ai\/dsh-credentials$/ }, () => ({ path: credentialsStub }))
      },
    }],
  })
  return import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
}

function makeResponse() {
  let status = 0
  let body = ''
  return {
    writeHead(nextStatus) { status = nextStatus },
    end(nextBody) { body = nextBody },
    result() { return { status, body: JSON.parse(body) } },
  }
}

function balanceBody(total, currency = 'CNY') {
  return {
    is_available: true,
    balance_infos: [{ currency, total_balance: total, granted_balance: 0, topped_up_balance: total }],
  }
}

function makeBalanceQueue(balances) {
  return { balances, index: 0 }
}

async function startHarness(temp, queue) {
  const originalFetch = globalThis.fetch
  const originalNow = Date.now
  const { apply } = await loadHostModule(temp)
  const routes = new Map()
  const ctx = {
    credentials: { resolve: async (ref) => ref === 'DEEPSEEK_API_KEY' ? { value: '<TEST_KEY>' } : undefined },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    effect(factory) { return factory() },
    get(name) { return name === 'dshHomePath' ? () => temp : undefined },
    logger: { warn() {} },
  }
  apply(ctx)
  let nowMs = Date.parse('2026-08-31T02:00:00.000Z')
  globalThis.fetch = async () => {
    const [total, currency] = queue.balances[queue.index++]
    return { ok: true, json: async () => balanceBody(total, currency) }
  }
  const state = routes.get('/api/whale-pet/state')
  return {
    state,
    async observe(advanceMs = 61_000) {
      nowMs += advanceMs
      Date.now = () => nowMs
      const response = makeResponse()
      await state({}, response)
      return response.result()
    },
    async setClock(timeIso) {
      nowMs = Date.parse(timeIso)
      Date.now = () => nowMs
    },
    restore() {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    },
  }
}

test('balance decreases drive spend; top-ups, same-balance polls, restarts, currency switches and rollovers behave correctly', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-balance-test-'))
  const balances = [
    [100, 'CNY'], [96, 'CNY'],                // baseline, spend 4
    [120, 'CNY'], [117.5, 'CNY'], [115.5, 'CNY'], // top-up, spend 2.5, spend 2
    [114, 'CNY'],                             // next Beijing day spend 1.5
    [100, 'USD'], [99, 'USD'],                // currency switch: USD baseline + spend 1
    [95, 'CNY'], [94, 'CNY'],                 // switch back: CNY spend 19, then concurrent spend 1
  ]
  const queue = makeBalanceQueue(balances)
  const harness = await startHarness(temp, queue)
  try {
    const baseline = await harness.observe(0)
    assert.equal(baseline.status, 200)
    assert.equal(baseline.body.balance.totalBalance, 100)
    assert.equal(baseline.body.spend.today.amount, 0, 'first observation is a zero baseline')
    assert.equal(baseline.body.spend.today.source, 'balance')

    const afterSpend = await harness.observe()
    assert.equal(afterSpend.body.balance.totalBalance, 96)
    assert.equal(afterSpend.body.spend.today.amount, 4, '¥100 → ¥96 must record ¥4 spend')
    assert.equal(afterSpend.body.spend.days7.amount, 4)

    // 同一余额重复轮询（0 间隔命中余额缓存）不得重复累计。
    const repeat = await harness.observe(0)
    assert.equal(repeat.body.spend.today.amount, 4, 'same-balance repeat must not double count')

    const afterTopUp = await harness.observe()
    assert.equal(afterTopUp.body.balance.totalBalance, 120)
    assert.equal(afterTopUp.body.spend.today.amount, 4, 'top-up must not subtract from accumulated spend')

    const afterMoreSpend = await harness.observe()
    assert.equal(afterMoreSpend.body.spend.today.amount, 6.5)
    assert.equal(afterMoreSpend.body.spend.days7.amount, 6.5)

    // 重启（重新加载宿主模块）后账本仍在。
    const restarted = await startHarness(temp, queue)
    const restart = await restarted.observe(61_000)
    assert.equal(restart.body.balance.totalBalance, 115.5)
    assert.equal(restart.body.spend.today.amount, 8.5, 'restart must preserve ledger and record the ¥2 decrease')

    // 跨北京时间午夜：今天的下降计入新日期。
    await restarted.setClock('2026-08-31T16:01:00.000Z')
    const nextDay = await restarted.observe(0)
    assert.equal(nextDay.body.balance.totalBalance, 114)
    assert.equal(nextDay.body.spend.today.amount, 1.5)
    assert.equal(nextDay.body.spend.days7.amount, 10)

    // 币种切换：USD 独立账本，CNY 历史保留。
    const usd = await restarted.observe()
    assert.equal(usd.body.balance.totalBalance, 100)
    assert.equal(usd.body.balance.currency, 'USD')
    assert.equal(usd.body.spend.today.amount, 0, 'first USD observation is a baseline')
    const usdSpend = await restarted.observe()
    assert.equal(usdSpend.body.spend.today.amount, 1, 'USD ¥100 → ¥99 records ¥1')
    assert.equal(usdSpend.body.spend.days7.amount, 1)

    // 切回 CNY：历史仍在，新增下降继续累计。
    const backCny = await restarted.observe()
    assert.equal(backCny.body.balance.currency, 'CNY')
    assert.equal(backCny.body.spend.today.amount, 20.5, 'CNY ledger preserved 1.5 and adds 19')

    // 并发 /state：single-flight 只抓取一次余额，只累计一次。
    const concurrent = await Promise.all([restarted.observe(61_000), restarted.observe(0)])
    for (const response of concurrent) {
      assert.equal(response.status, 200)
      assert.equal(response.body.spend.today.amount, 21.5, 'concurrent same-balance polls count the decrease once')
    }
  } finally {
    harness.restore()
    await rm(temp, { recursive: true, force: true })
  }
})
