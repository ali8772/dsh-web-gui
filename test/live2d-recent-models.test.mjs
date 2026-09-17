import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')

async function loadComponent(temp) {
  const outfile = join(temp, 'recent-models.mjs')
  await build({
    entryPoints: [join(root, 'src/client/live2d/recent-models.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile,
    logLevel: 'silent',
  })
  return import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
}

function collect(node, output = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, output)
    return output
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return output
  output.push(node)
  collect(node.props.children, output)
  return output
}

test('recent-model settings render current state and dispatch switch/delete actions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-recent-models-'))
  try {
    const { Live2DRecentModels } = await loadComponent(temp)
    const actions = []
    const models = [
      { id: 'active', name: 'Aurora', kind: 'zip', importedAt: 1, lastUsedAt: 2, active: true },
      { id: 'saved', name: 'Haru', kind: 'url', importedAt: 1, lastUsedAt: 1, active: false },
    ]
    const tree = Live2DRecentModels({
      models,
      busy: false,
      onSwitch: (model) => actions.push(`switch:${model.id}`),
      onDelete: (model) => actions.push(`delete:${model.id}`),
    })
    const elements = collect(tree)
    assert.equal(elements.some(({ props }) => props.role === 'list'), true)
    assert.equal(elements.filter(({ props }) => props.role === 'listitem').length, 2)

    const switchButtons = elements.filter(({ props }) => props['data-live2d-model-id'] !== undefined)
    assert.deepEqual(switchButtons.map(({ props }) => props['aria-pressed']), [true, false])
    assert.equal(switchButtons[0].props.disabled, true)
    switchButtons[1].props.onClick()

    const deleteButtons = elements.filter(({ props }) => props['data-live2d-delete-id'] !== undefined)
    deleteButtons[0].props.onClick()
    assert.deepEqual(actions, ['switch:saved', 'delete:active'])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
