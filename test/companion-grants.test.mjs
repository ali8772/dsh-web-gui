import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(import.meta.dirname, '..')

async function loadModule(temp) {
  const outfile = join(temp, 'companion-grants.mjs')
  const credentialsStub = join(temp, 'credentials-stub.mjs')
  await (await import('node:fs/promises')).writeFile(
    credentialsStub,
    "export const credentialKey = (scope, id) => `${scope}/${id}`\n",
    'utf8',
  )
  await build({
    entryPoints: [join(projectRoot, 'src/host/companion-grants.ts')],
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

class MemoryRecords {
  current

  async readRecord() {
    return this.current
  }

  async modifyRecord(_key, mutate) {
    const next = await mutate(this.current)
    if (next !== undefined) this.current = structuredClone(next)
    return structuredClone(this.current)
  }

  async deleteRecord() {
    this.current = undefined
  }
}

test('companion authorization is loopback-only and revocation takes effect immediately', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-grant-test-'))
  try {
    const { createCompanionGrants } = await loadModule(temp)
    const grants = createCompanionGrants(new MemoryRecords())
    const issued = await grants.issue('Rust')
    const bearer = `Bearer ${issued.token}`

    for (const address of ['127.0.0.1', '127.42.0.9', '::1', '::ffff:127.0.0.1']) {
      assert.deepEqual(await grants.authenticate(address, bearer), issued.grant, address)
    }
    assert.equal(await grants.authenticate('192.168.1.4', bearer), null)
    assert.equal(await grants.authenticate('127.0.0.1', `Bearer ${issued.token}x`), null)
    assert.equal(await grants.authenticate('127.0.0.1', [bearer, bearer]), null)

    assert.equal(await grants.revoke(issued.grant.id), true)
    assert.equal(await grants.authenticate('127.0.0.1', bearer), null)
    assert.deepEqual(await grants.list(), [])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('concurrent companion issues preserve both grants through atomic record updates', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-grant-test-'))
  try {
    const { createCompanionGrants } = await loadModule(temp)
    const records = new MemoryRecords()
    let tail = Promise.resolve()
    records.modifyRecord = async function (_key, mutate) {
      const result = tail.then(async () => {
        const next = await mutate(this.current)
        if (next !== undefined) this.current = structuredClone(next)
        return structuredClone(this.current)
      })
      tail = result.then(() => undefined, () => undefined)
      return result
    }
    const grants = createCompanionGrants(records)

    const [powerShell, rust] = await Promise.all([
      grants.issue('PowerShell'),
      grants.issue('Rust'),
    ])
    assert.deepEqual(await grants.list(), [powerShell.grant, rust.grant])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('companion grant token is shown once while durable storage contains only a verifier', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-grant-test-'))
  try {
    const { createCompanionGrants } = await loadModule(temp)
    const records = new MemoryRecords()
    const grants = createCompanionGrants(records)

    const issued = await grants.issue('PowerShell')
    assert.match(issued.token, /^wpg1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(issued.token.split('.')[2], 'base64url').length, 32)
    assert.deepEqual(await grants.list(), [issued.grant])

    const durable = JSON.stringify(records.current)
    assert.equal(durable.includes(issued.token), false)
    assert.equal(durable.includes(issued.token.split('.')[2]), false)
    assert.equal('digest' in (await grants.list())[0], false)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
