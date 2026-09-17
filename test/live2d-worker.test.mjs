import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('ZIP import uses a dedicated module Worker and transfers its ArrayBuffer', async () => {
  const [build, client, widget] = await Promise.all([
    readFile(resolve(root, 'build.mjs'), 'utf8'),
    readFile(resolve(root, 'src/client/live2d/zip-client.ts'), 'utf8'),
    readFile(resolve(root, 'src/client/widget.tsx'), 'utf8'),
  ])
  assert.match(build, /zip-worker\.ts/)
  assert.match(build, /live2d-zip-worker\.js/)
  assert.match(client, /new Worker\([^\n]+type:\s*'module'/)
  assert.match(client, /postMessage\(bytes,\s*\[bytes\]\)/)
  assert.match(widget, /prepareModelFromZipWorker\(bytes, signal\)/)
  assert.match(client, /signal\?\.addEventListener\('abort'/)
  assert.match(client, /worker\.terminate\(\)/)
})
