import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const projectRoot = resolve(import.meta.dirname, '..')

test('PowerShell companion stores pairing material with CurrentUser DPAPI and sends Bearer auth', async () => {
  const script = await readFile(resolve(projectRoot, 'windows/WhaleMaidPet.ps1'), 'utf8')
  assert.match(script, /Protect-CompanionToken/)
  assert.match(script, /DataProtectionScope\]::CurrentUser/)
  assert.match(script, /companion-token\.dat/)
  assert.match(script, /AuthenticationHeaderValue\]::new\('Bearer',\s*\$companionToken\)/)
  assert.match(script, /\/dsh-whale-pet\/companion\/v1\/state/)
  assert.doesNotMatch(script, /ConvertTo-Json[^\n]*\$token/)
  assert.match(script, /if \(\$env:DSH_WHALE_PET_COMPANION_TOKEN\) \{\s*try \{ Protect-CompanionToken/)
  assert.doesNotMatch(script, /DSH_WHALE_PET_COMPANION_TOKEN -and -not \(Test-Path \$script:CompanionTokenFile\)/)
  assert.match(script, /function Get-CompanionBaseUrl/)
  assert.match(script, /\$uri\.Host -notin @\('localhost', '127\.0\.0\.1', '::1'\)/)
})

test('Rust companion centralizes Bearer injection and reports pairing-required responses', async () => {
  const [client, main, manifest, lock] = await Promise.all([
    readFile(resolve(projectRoot, 'windows-rust/src/dsh_client.rs'), 'utf8'),
    readFile(resolve(projectRoot, 'windows-rust/src/main.rs'), 'utf8'),
    readFile(resolve(projectRoot, 'windows-rust/Cargo.toml'), 'utf8'),
    readFile(resolve(projectRoot, 'windows-rust/Cargo.lock'), 'utf8'),
  ])
  assert.match(client, /PairingRequired/)
  assert.match(client, /bearer_auth/)
  assert.match(client, /COMPANION_PREFIX:\s*&str\s*=\s*"\/dsh-whale-pet\/companion\/v1"/)
  assert.match(client, /get_companion\("state"\)/)
  assert.match(main, /DSH_WHALE_PET_COMPANION_TOKEN/)
  assert.match(manifest, /keyring/)
  assert.match(lock, /name = "keyring"/)
})
