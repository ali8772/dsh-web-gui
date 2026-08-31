/** Build the DSH host bundle and browser client bundle. */
import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const lib = join(root, 'lib')
await mkdir(lib, { recursive: true })

await build({
  entryPoints: [join(root, 'src/host/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: join(lib, 'index.js'),
  external: ['@deepseek-ai/*', 'node:*'],
  logLevel: 'warning',
})

await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'chrome100',
  outfile: join(lib, '.client-raw.js'),
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  loader: { '.css': 'text', '.png': 'dataurl' },
  jsx: 'automatic',
  logLevel: 'warning',
})

const raw = await readFile(join(lib, '.client-raw.js'), 'utf8')
const wrapped = `window.__ModuleLoader__.load({ id: 'dsh-whale-pet', factory: (require) => {\n`
  + `var module = { exports: {} };\nvar exports = module.exports;\n`
  + raw
  + `\nreturn module.exports;\n} });\n`
await writeFile(join(lib, 'client.js'), wrapped, 'utf8')
await rm(join(lib, '.client-raw.js'), { force: true })
await rm(join(lib, 'index.js.map'), { force: true })
await rm(join(lib, 'client.js.map'), { force: true })
console.log('dsh-whale-pet: built lib/index.js + lib/client.js')
