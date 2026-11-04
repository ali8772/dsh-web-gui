import { spawnSync } from 'node:child_process'

const allowed = new Map([
  ['GHSA-8mmm-9v2q-x3f9', 'pixi-live2d-display@0.4.0 incorrectly declares build-only gh-pages@4 as a runtime dependency; it is never imported or bundled.'],
  ['GHSA-g3hv-75wg-m249', 'minimatch@3 is pulled only by the unused gh-pages@4 publishing tree (gh-pages -> globby -> glob -> minimatch); the renderer never imports it and the only fix downgrades pixi-live2d-display.'],
])
const result = spawnSync(
  'npm',
  ['audit', '--omit=dev', '--json', '--registry=https://registry.npmjs.org'],
  {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
      'npm_command',
      'npm_lifecycle_event',
      'npm_config_allow_scripts',
    ].includes(name))),
  },
)
if (result.error !== undefined) throw result.error
if (result.stdout.trim() === '') {
  process.stderr.write(result.stderr)
  throw new Error(`npm audit returned no report (exit ${result.status ?? 'unknown'})`)
}
let report
try {
  report = JSON.parse(result.stdout)
} catch {
  process.stderr.write(result.stderr)
  throw new Error('npm audit did not return JSON')
}
if (report.error !== undefined) throw new Error(`npm audit failed: ${report.error.summary ?? report.error.code ?? 'unknown error'}`)
const findings = []
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (typeof via !== 'object' || typeof via.url !== 'string') continue
    const id = via.url.split('/').pop()
    if (id !== undefined) findings.push({ id, package: vulnerability.name, severity: via.severity })
  }
}
const unexpected = findings.filter(({ id }) => !allowed.has(id))
const expectedMissing = [...allowed.keys()].filter((id) => !findings.some((finding) => finding.id === id))
for (const finding of findings) {
  const reason = allowed.get(finding.id)
  console.log(`${reason === undefined ? 'FAIL' : 'ALLOW'} ${finding.id} ${finding.package} ${finding.severity}${reason === undefined ? '' : ` — ${reason}`}`)
}
for (const id of expectedMissing) console.log(`STALE ${id} — remove this resolved advisory from the allowlist`)
if (unexpected.length > 0 || expectedMissing.length > 0) process.exitCode = 1
