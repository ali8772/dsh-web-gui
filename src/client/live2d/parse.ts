/**
 * Live2D 导入的纯逻辑层：ZIP 解包、Cubism 模型 JSON 解析、资源路径归一化。
 * 不依赖浏览器 API，可被 Node 单元测试直接加载。
 */

import { unzipSync } from 'fflate'

export type Live2DKinds = 'zip' | 'url'

export const MAX_ZIP_FILES = 2_048
export const MAX_ZIP_UNCOMPRESSED_BYTES = 256 * 1024 * 1024

export function basename(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop() ?? path
}

/**
 * 归一化模型 JSON 中的相对资源路径。拒绝 URL、绝对路径、NUL 和越过根目录。
 * ZIP 不会写入文件系统，但这些限制可以避免歧义路径和意外网络访问。
 */
export function normalizeModelReference(path: string): string | null {
  if (path === '' || path.includes('\0')) return null
  const posix = path.replaceAll('\\', '/')
  if (posix.startsWith('/') || posix.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(posix)) return null
  const output: string[] = []
  for (const part of posix.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (output.length > 0 && output.at(-1) !== '..') output.pop()
      else output.push('..')
    } else {
      output.push(part)
    }
  }
  return output.length > 0 ? output.join('/') : null
}

function normalizeArchivePath(path: string): string | null {
  if (path === '' || path.includes('\0')) return null
  const output: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (output.length === 0) return null
      output.pop()
    } else {
      output.push(part)
    }
  }
  return output.length > 0 ? output.join('/') : null
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** 将根 model3.json 内的引用解析到 ZIP 的完整条目路径。 */
export function resolveZipAssetPath(rootJsonPath: string, reference: string): string | null {
  const normalizedReference = normalizeModelReference(reference)
  if (normalizedReference === null) return null
  const root = normalizeArchivePath(rootJsonPath)
  if (root === null) return null
  return normalizeArchivePath(`${dirname(root)}/${normalizedReference}`)
}

export interface Live2DConfig {
  kind: Live2DKinds
  /** 模型名（来自根 JSON 或用户提供）。 */
  name: string
  /** URL 模式的根 model3.json 地址。 */
  url?: string
  /** ZIP 内或 URL 中的根模型 JSON 路径，仅用于诊断与恢复。 */
  rootJsonPath?: string
  importedAt: number
  schemaVersion?: 1
}

export interface ZipEntry {
  path: string
  bytes: Uint8Array
}

export interface ZipModel {
  kind: 'zip'
  name: string
  rootJsonPath: string
  entries: ZipEntry[]
}

/** 模型 JSON 中的文件引用。 */
export interface AssetRefs {
  files: string[]
  /** 首个主资源（通常为 moc3），便于错误定位。 */
  primary: string
}

/** 在 ZIP 中寻找最浅层的 Cubism 3/4/5 根 JSON，并限制解压规模。 */
export function findModelRootZip(zip: Uint8Array): ZipModel | null {
  let count = 0
  let totalSize = 0
  const unpacked = unzipSync(zip, {
    filter: (file) => {
      const path = file.name.replaceAll('\\', '/')
      if (path.startsWith('__MACOSX/') || path.endsWith('/')) return false
      count += 1
      totalSize += file.originalSize
      if (count > MAX_ZIP_FILES) throw new Error(`ZIP 文件数超过限制（${MAX_ZIP_FILES}）`)
      if (totalSize > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error('ZIP 解压后超过 256 MiB 限制')
      return true
    },
  })

  const byPath = new Map<string, Uint8Array>()
  for (const [rawPath, bytes] of Object.entries(unpacked)) {
    const path = normalizeArchivePath(rawPath)
    if (path === null) continue
    if (byPath.has(path)) throw new Error(`ZIP 包含重复路径：${path}`)
    byPath.set(path, bytes)
  }
  const roots = [...byPath.keys()]
    .filter((path) => path.toLowerCase().endsWith('.model3.json'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const rootJsonPath = roots[0]
  if (rootJsonPath === undefined) return null
  const name = basename(rootJsonPath).replace(/\.model3\.json$/iu, '') || 'Live2D 模型'
  return {
    kind: 'zip',
    name,
    rootJsonPath,
    entries: [...byPath].map(([path, bytes]) => ({ path, bytes })),
  }
}

/** 从 Cubism model3.json 提取 moc3、贴图、物理、姿势、动作、声音等资源。 */
export function assetRefsFromModelJson(json: unknown, _rootPath = ''): AssetRefs | null {
  if (json === null || typeof json !== 'object') return null
  const fileRefs = (json as { FileReferences?: unknown }).FileReferences
  if (fileRefs === null || typeof fileRefs !== 'object') return null

  const files = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || value === '') return
    const normalized = normalizeModelReference(value)
    if (normalized === null) throw new Error(`模型包含不安全的资源路径：${value}`)
    files.add(normalized)
  }
  const refs = fileRefs as Record<string, unknown>
  for (const key of ['Moc', 'Physics', 'Pose', 'UserData', 'DisplayInfo'] as const) add(refs[key])
  if (Array.isArray(refs.Textures)) for (const texture of refs.Textures) add(texture)

  if (refs.Motions !== null && typeof refs.Motions === 'object') {
    for (const group of Object.values(refs.Motions as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue
      for (const entry of group) {
        if (entry === null || typeof entry !== 'object') continue
        add((entry as { File?: unknown }).File)
        add((entry as { Sound?: unknown }).Sound)
      }
    }
  }
  if (Array.isArray(refs.Expressions)) {
    for (const expression of refs.Expressions) {
      if (expression !== null && typeof expression === 'object') add((expression as { File?: unknown }).File)
    }
  }

  const list = [...files]
  return list.length > 0 ? { files: list, primary: list[0]! } : null
}

/** 将 model3.json 中的资源引用映射到另一套 URL；保留给纯逻辑测试和诊断。 */
export function rewriteModelJsonUrls(json: unknown, urlOf: (rel: string) => string): unknown {
  if (json === null || typeof json !== 'object') return json
  if (Array.isArray(json)) return json.map((value) => rewriteModelJsonUrls(value, urlOf))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (['File', 'Sound', 'Moc', 'Physics', 'Pose', 'UserData', 'DisplayInfo'].includes(key)
      && typeof value === 'string' && value !== '') {
      out[key] = urlOf(value)
    } else if (key === 'Textures' && Array.isArray(value)) {
      out[key] = value.map((item) => typeof item === 'string' && item !== '' ? urlOf(item) : item)
    } else {
      out[key] = rewriteModelJsonUrls(value, urlOf)
    }
  }
  return out
}

export interface StoredModel {
  config: Live2DConfig
  /** model3.json 引用路径 → 资源 bytes；保留目录，防止同名文件冲突。 */
  files: Record<string, Uint8Array>
  modelJson: unknown
  rootJsonPath: string
}

/** 把 ZIP 模型转换为根 JSON 引用路径 → bytes 的统一存储形态。 */
export function materializeZipModel(zip: ZipModel, rootJson: unknown): StoredModel {
  const refs = assetRefsFromModelJson(rootJson, zip.rootJsonPath)
  if (refs === null) throw new Error('模型 JSON 中没有可用资源')
  const entries = new Map(zip.entries.map((entry) => [entry.path, entry.bytes]))
  const files: Record<string, Uint8Array> = {}
  for (const reference of refs.files) {
    const archivePath = resolveZipAssetPath(zip.rootJsonPath, reference)
    const bytes = archivePath === null ? undefined : entries.get(archivePath)
    if (bytes === undefined) throw new Error(`ZIP 中缺少资源：${reference}`)
    files[reference] = bytes
  }
  return {
    config: {
      kind: 'zip',
      name: zip.name,
      rootJsonPath: zip.rootJsonPath,
      importedAt: Date.now(),
      schemaVersion: 1,
    },
    files,
    modelJson: rootJson,
    rootJsonPath: zip.rootJsonPath,
  }
}
