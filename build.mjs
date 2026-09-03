/** Build the DSH host bundle and browser client bundle. */
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

// Live2D 动态 chunk（仅供 widget 导入模型时经宿主路由动态加载）。
await build({
  entryPoints: [join(root, 'src/client/live2d/chunk.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome100',
  outfile: join(lib, 'live2d.js'),
  loader: { '.css': 'text', '.png': 'dataurl' },
  logLevel: 'warning',
})

// Cubism Core 是官方协议标注的 Redistributable Code。固定在 vendor/，构建时复制，
// 浏览器只从本地 DSH 路由加载，避免离线环境或 CDN 不可达导致启动失败。
await copyFile(
  join(root, 'vendor/live2dcubismcore.min.js'),
  join(lib, 'live2dcubismcore.min.js'),
)
console.log('dsh-whale-pet: built host/client/Live2D chunks + local Cubism Core')
