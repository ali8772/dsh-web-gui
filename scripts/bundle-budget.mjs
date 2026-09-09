import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const budgets = {
  'lib/index.js': 96 * 1024,
  'lib/client.js': 360 * 1024,
  'lib/live2d.js': 1536 * 1024,
  'lib/live2d-zip-worker.js': 64 * 1024,
  'lib/live2dcubismcore.min.js': 256 * 1024,
}

let failed = false
for (const [path, limit] of Object.entries(budgets)) {
  const { size } = await stat(resolve(path))
  const status = size <= limit ? 'ok' : 'over'
  console.log(`${status.padEnd(4)} ${path}: ${size} / ${limit} bytes`)
  if (size > limit) failed = true
}
if (failed) process.exitCode = 1
