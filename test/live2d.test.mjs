import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'

const projectRoot = resolve(import.meta.dirname, '..')

async function withParseModule(run) {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-whale-live2d-test-'))
  try {
    const outfile = join(temp, 'live2d-parse.mjs')
    await build({
      entryPoints: [join(projectRoot, 'src/client/live2d/parse.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      outfile,
      logLevel: 'silent',
    })
    await run(await import(pathToFileURL(outfile).href))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

const CUBISM4_JSON = {
  Version: 3,
  FileReferences: {
    Moc: 'model.moc3',
    Textures: ['textures/texture_00.png'],
    Physics: 'model.physics3.json',
    Pose: 'model.pose3.json',
    Motions: {
      Idle: [{ File: 'motions/idle_00.motion3.json', FadeInTime: 0.5 }],
      TapBody: [{ File: 'motions/tap_00.motion3.json', Sound: 'sounds/tap.wav' }],
    },
    Expressions: [{ Name: 'smile', File: 'expressions/smile.exp3.json' }],
  },
}

function completeZipFiles(root = 'Haru') {
  return {
    [`${root}/${root}.model3.json`]: strToU8(JSON.stringify(CUBISM4_JSON)),
    [`${root}/model.moc3`]: strToU8('MOC3'),
    [`${root}/textures/texture_00.png`]: strToU8('png'),
    [`${root}/model.physics3.json`]: strToU8('{}'),
    [`${root}/model.pose3.json`]: strToU8('{}'),
    [`${root}/motions/idle_00.motion3.json`]: strToU8('{}'),
    [`${root}/motions/tap_00.motion3.json`]: strToU8('{}'),
    [`${root}/sounds/tap.wav`]: strToU8('wav'),
    [`${root}/expressions/smile.exp3.json`]: strToU8('{}'),
  }
}

test('findModelRootZip detects the shallowest model3.json and filters macOS metadata', async () => {
  await withParseModule(async ({ findModelRootZip }) => {
    const zip = zipSync({
      '__MACOSX/._Haru.model3.json': strToU8('junk'),
      ...completeZipFiles('Haru'),
      'Haru/backup/Other.model3.json': strToU8(JSON.stringify(CUBISM4_JSON)),
    })
    const model = findModelRootZip(zip)
    assert.ok(model !== null)
    assert.equal(model.rootJsonPath, 'Haru/Haru.model3.json')
    assert.equal(model.name, 'Haru')
    assert.ok(!model.entries.some((entry) => entry.path.startsWith('__MACOSX')))
  })
})

test('Cubism 2 .model.json is not accepted by the Cubism 4 runtime importer', async () => {
  await withParseModule(async ({ findModelRootZip }) => {
    const zip = zipSync({
      'legacy/legacy.model.json': strToU8('{"model":"legacy.moc"}'),
      'legacy/legacy.moc': strToU8('moc'),
    })
    assert.equal(findModelRootZip(zip), null)
  })
})

test('assetRefsFromModelJson extracts moc, textures, optional files, motions, sound, and expressions', async () => {
  await withParseModule(async ({ assetRefsFromModelJson }) => {
    const refs = assetRefsFromModelJson(CUBISM4_JSON, 'Haru/Haru.model3.json')
    assert.ok(refs !== null)
    for (const expected of [
      'model.moc3',
      'textures/texture_00.png',
      'model.physics3.json',
      'model.pose3.json',
      'motions/idle_00.motion3.json',
      'motions/tap_00.motion3.json',
      'sounds/tap.wav',
      'expressions/smile.exp3.json',
    ]) assert.ok(refs.files.includes(expected), `缺少 ${expected}`)
    assert.equal(refs.primary, 'model.moc3')
  })
})

test('absolute and URL references are rejected; parent references remain root-bound', async () => {
  await withParseModule(async ({ assetRefsFromModelJson, normalizeModelReference, resolveZipAssetPath }) => {
    for (const unsafe of ['/etc/passwd', 'https://evil.invalid/x', 'C:\\secret']) {
      assert.equal(normalizeModelReference(unsafe), null, unsafe)
      const json = { Version: 3, FileReferences: { Moc: unsafe, Textures: ['texture.png'] } }
      assert.throws(() => assetRefsFromModelJson(json), /不安全/)
    }
    assert.equal(normalizeModelReference('motions/../textures/a.png'), 'textures/a.png')
    assert.equal(normalizeModelReference('../shared/a.png'), '../shared/a.png')
    assert.equal(resolveZipAssetPath('model/Haru.model3.json', '../shared/a.png'), 'shared/a.png')
    assert.equal(resolveZipAssetPath('Haru.model3.json', '../../secret'), null)
  })
})

test('rewriteModelJsonUrls rewrites every resource including motion sound', async () => {
  await withParseModule(async ({ rewriteModelJsonUrls }) => {
    const rewritten = rewriteModelJsonUrls(CUBISM4_JSON, (rel) => `asset:${rel}`)
    const refs = rewritten.FileReferences
    assert.equal(refs.Moc, 'asset:model.moc3')
    assert.deepEqual(refs.Textures, ['asset:textures/texture_00.png'])
    assert.equal(refs.Motions.Idle[0].File, 'asset:motions/idle_00.motion3.json')
    assert.equal(refs.Motions.TapBody[0].Sound, 'asset:sounds/tap.wav')
    assert.equal(refs.Expressions[0].File, 'asset:expressions/smile.exp3.json')
  })
})

test('materializeZipModel preserves relative paths and avoids basename collisions', async () => {
  await withParseModule(async ({ findModelRootZip, materializeZipModel }) => {
    const json = structuredClone(CUBISM4_JSON)
    json.FileReferences.Textures = ['body/texture.png', 'face/texture.png']
    const files = completeZipFiles('Model')
    delete files['Model/textures/texture_00.png']
    files['Model/Model.model3.json'] = strToU8(JSON.stringify(json))
    files['Model/body/texture.png'] = strToU8('body')
    files['Model/face/texture.png'] = strToU8('face')
    const model = findModelRootZip(zipSync(files))
    assert.ok(model !== null)
    const stored = materializeZipModel(model, json)
    assert.equal(stored.config.kind, 'zip')
    assert.equal(stored.config.name, 'Model')
    assert.equal(new TextDecoder().decode(stored.files['body/texture.png']), 'body')
    assert.equal(new TextDecoder().decode(stored.files['face/texture.png']), 'face')
    assert.equal(stored.files['texture.png'], undefined)
  })
})

test('resolveZipAssetPath resolves references relative to nested model root', async () => {
  await withParseModule(async ({ resolveZipAssetPath }) => {
    assert.equal(resolveZipAssetPath('archive/model/Haru.model3.json', 'textures/a.png'), 'archive/model/textures/a.png')
    assert.equal(resolveZipAssetPath('archive/model/Haru.model3.json', '../shared/a.png'), 'archive/shared/a.png')
    assert.equal(resolveZipAssetPath('Haru.model3.json', '../../secret'), null)
  })
})

test('materializeZipModel reports a missing referenced asset before persistence', async () => {
  await withParseModule(async ({ findModelRootZip, materializeZipModel }) => {
    const files = completeZipFiles('Broken')
    delete files['Broken/model.moc3']
    const model = findModelRootZip(zipSync(files))
    assert.ok(model !== null)
    assert.throws(() => materializeZipModel(model, CUBISM4_JSON), /缺少资源：model\.moc3/)
  })
})
