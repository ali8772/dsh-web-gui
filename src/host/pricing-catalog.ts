/**
 * Weekly models.dev price catalog refresh with a last-known-good local snapshot.
 *
 * The remote feed is treated as untrusted data. Only a small, validated provider/model
 * cost projection is retained under `$DSH_HOME/whale-pet`; the raw catalog never enters
 * the runtime pricing path.
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import {
  DEFAULT_USD_TO_CNY,
  createPriceCache,
  officialPriceRows,
} from './pricing.ts'
import type {
  ExternalPriceCatalog,
  ExternalPriceRecord,
  PriceAtResult,
  PriceUnit,
  PricingSnapshot,
} from './pricing.ts'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const PRICING_CACHE_RELATIVE_PATH = join('whale-pet', 'models-dev.json')
export const PRICING_REFRESH_MS = 7 * 86_400_000
export const PRICING_RETRY_MS = 60 * 60_000
const MAX_FEED_BYTES = 8 * 1024 * 1024
const MAX_PROVIDERS = 512
const MAX_MODELS = 100_000
const MAX_KEY_LENGTH = 160

/** Explicit DSH adapter aliases; never perform fuzzy model/provider matching. */
export const EXTERNAL_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  codex: 'openai',
}

export interface PricingManagerOptions {
  readonly home: string
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly usdToCny?: number
  readonly sourceUrl?: string
}

export interface PricingManager {
  readonly snapshot: () => PricingSnapshot
  readonly refresh: (force?: boolean) => Promise<PricingSnapshot>
  /** 当前价目表（官方 + 外部目录），用于浏览器展示与用量统计口径对齐。 */
  readonly table: (nowMs?: number) => PriceTableSnapshot
  readonly cachePath: string
}

/** 价目表中的单个外部模型价格（USD 原价 + CNY 展示估算）。 */
export interface PriceTableModel {
  readonly id: string
  readonly usd: PriceUnit
  readonly cny: PriceUnit
}

export interface PriceTableProvider {
  readonly id: string
  /** models.dev 提供的供应商展示名；旧缓存可能没有。 */
  readonly name?: string
  readonly models: ReadonlyArray<PriceTableModel>
}

export interface PriceTableOfficialRow {
  readonly model: string
  readonly usd: PriceUnit
  readonly cny: PriceUnit
  readonly mode: 'flat' | 'peak' | 'offPeak'
}

/** 浏览器「价目表」页面的完整数据快照。 */
export interface PriceTableSnapshot {
  readonly revision: string
  readonly source: 'builtin' | 'models.dev' | 'mixed'
  readonly fetchedAt: number | null
  readonly nextRefreshAt: number | null
  readonly usdToCny: number
  readonly official: ReadonlyArray<PriceTableOfficialRow>
  readonly providers: ReadonlyArray<PriceTableProvider>
  readonly modelCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function safeKey(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_KEY_LENGTH
    && value !== '__proto__'
    && value !== 'constructor'
    && value !== 'prototype'
}

/** 展示名仅用于界面；截断长度并丢弃控制字符，不参与任何计价。 */
function safeDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, MAX_KEY_LENGTH)
  return cleaned === '' ? undefined : cleaned
}

function priceRecord(input: number, output: number, cacheRead: number): ExternalPriceRecord {
  return { usd: { input, cacheRead, output } }
}

function catalogProviders(): Record<string, { name?: string; models: Record<string, ExternalPriceRecord> }> {
  return Object.create(null) as Record<string, { name?: string; models: Record<string, ExternalPriceRecord> }>
}

function modelRecords(): Record<string, ExternalPriceRecord> {
  return Object.create(null) as Record<string, ExternalPriceRecord>
}

/** Normalize and bound the models.dev root object into the compact runtime catalog. */
export function normalizeModelsDevCatalog(
  body: unknown,
  options: { fetchedAt: number; source?: string; sha256?: string; usdToCny?: number },
): ExternalPriceCatalog | undefined {
  if (!isRecord(body)) return undefined
  const providers = catalogProviders()
  let providerCount = 0
  let modelCount = 0

  for (const [provider, rawProvider] of Object.entries(body)) {
    if (!safeKey(provider) || !isRecord(rawProvider)) continue
    if (providerCount >= MAX_PROVIDERS) return undefined
    const rawModels = rawProvider.models
    if (!isRecord(rawModels)) continue
    const models = modelRecords()
    for (const [model, rawModel] of Object.entries(rawModels)) {
      if (!safeKey(model) || !isRecord(rawModel)) continue
      if (++modelCount > MAX_MODELS) return undefined
      const rawCost = rawModel.cost
      if (!isRecord(rawCost)) continue
      const input = finiteNonNegative(rawCost.input)
      const output = finiteNonNegative(rawCost.output)
      if (input === undefined || output === undefined) continue
      // Missing cache_read means cached input is billed at input rate; explicit zero
      // remains free and is not confused with absent metadata.
      const cacheRead = finiteNonNegative(rawCost.cache_read) ?? input
      models[model] = priceRecord(input, output, cacheRead)
    }
    if (Object.keys(models).length === 0) continue
    const name = safeDisplayName(rawProvider.name)
    providers[provider] = name === undefined ? { models } : { name, models }
    providerCount += 1
  }

  if (providerCount === 0 || modelCount === 0) return undefined
  const fetchedAt = finiteNonNegative(options.fetchedAt)
  if (fetchedAt === undefined) return undefined
  const usdToCny = finiteNonNegative(options.usdToCny) ?? DEFAULT_USD_TO_CNY
  if (usdToCny <= 0) return undefined
  return {
    version: 1,
    source: options.source ?? MODELS_DEV_URL,
    fetchedAt,
    revision: options.sha256 ?? `models.dev:${fetchedAt}`,
    usdToCny,
    providers,
  }
}

/** Validate the compact on-disk projection without trusting arbitrary object fields. */
function validateCatalog(value: unknown): ExternalPriceCatalog | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const fetchedAt = finiteNonNegative(value.fetchedAt)
  if (fetchedAt === undefined) return undefined
  if (!isRecord(value.providers)) return undefined
  const providers = catalogProviders()
  let providerCount = 0
  let modelCount = 0

  for (const [provider, rawProvider] of Object.entries(value.providers)) {
    if (!safeKey(provider) || !isRecord(rawProvider) || !isRecord(rawProvider.models)) continue
    if (providerCount >= MAX_PROVIDERS) return undefined
    const models = modelRecords()
    for (const [model, rawModel] of Object.entries(rawProvider.models)) {
      if (!safeKey(model) || !isRecord(rawModel) || !isRecord(rawModel.usd)) continue
      if (++modelCount > MAX_MODELS) return undefined
      const input = finiteNonNegative(rawModel.usd.input)
      const output = finiteNonNegative(rawModel.usd.output)
      const cacheRead = finiteNonNegative(rawModel.usd.cacheRead)
      if (input === undefined || output === undefined || cacheRead === undefined) continue
      models[model] = priceRecord(input, output, cacheRead)
    }
    if (Object.keys(models).length === 0) continue
    const name = safeDisplayName(rawProvider.name)
    providers[provider] = name === undefined ? { models } : { name, models }
    providerCount += 1
  }

  if (providerCount === 0 || modelCount === 0) return undefined
  const usdToCny = finiteNonNegative(value.usdToCny) ?? DEFAULT_USD_TO_CNY
  if (usdToCny <= 0) return undefined
  return {
    version: 1,
    source: typeof value.source === 'string' ? value.source : MODELS_DEV_URL,
    fetchedAt,
    revision: typeof value.revision === 'string' && value.revision !== ''
      ? value.revision
      : typeof value.sha256 === 'string' && value.sha256 !== '' ? value.sha256 : `models.dev:${fetchedAt}`,
    usdToCny,
    providers,
  }
}

export function readPricingCatalog(path: string): ExternalPriceCatalog | undefined {
  try {
    return validateCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

function writePricingCatalog(path: string, catalog: ExternalPriceCatalog): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(catalog)}\n`)
    closeSync(fd)
    renameSync(temporary, path)
  } finally {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(temporary) } catch { /* already moved or gone */ }
  }
}

async function readResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) throw new Error('pricing feed too large')
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_FEED_BYTES) throw new Error('pricing feed too large')
    return new TextDecoder().decode(bytes)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_FEED_BYTES) throw new Error('pricing feed too large')
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function snapshotFor(catalog: ExternalPriceCatalog | undefined): PricingSnapshot {
  const lookup = createPriceCache(catalog === undefined ? undefined : {
    externalCatalog: catalog,
    usdToCny: catalog.usdToCny ?? DEFAULT_USD_TO_CNY,
  })
  const aliases = EXTERNAL_PROVIDER_ALIASES
  const routeLookup = (model: string, timeMs: number, provider = ''): PriceAtResult => {
    const catalogProvider = aliases[provider] ?? provider
    return lookup(model, timeMs, catalogProvider)
  }
  return {
    revision: catalog?.revision ?? 'builtin',
    source: catalog === undefined ? 'builtin' : 'mixed',
    fetchedAt: catalog?.fetchedAt ?? null,
    lookup: routeLookup,
  }
}

function convertUsd(unit: PriceUnit, usdToCny: number): PriceUnit {
  return {
    input: unit.input * usdToCny,
    cacheRead: unit.cacheRead * usdToCny,
    output: unit.output * usdToCny,
  }
}

/** 由当前目录与官方政策构建只读价目表快照；与计价使用同一份数据。 */
function tableFor(catalog: ExternalPriceCatalog | undefined, nowMs: number): PriceTableSnapshot {
  const usdToCny = catalog?.usdToCny ?? DEFAULT_USD_TO_CNY
  const providers: PriceTableProvider[] = []
  let modelCount = 0
  if (catalog !== undefined) {
    for (const [id, provider] of Object.entries(catalog.providers)) {
      const models = Object.entries(provider.models)
        .map(([model, record]) => ({
          id: model,
          usd: record.usd,
          cny: record.cny ?? convertUsd(record.usd, usdToCny),
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
      modelCount += models.length
      providers.push({
        id,
        ...(provider.name === undefined ? {} : { name: provider.name }),
        models,
      })
    }
    providers.sort((a, b) => a.id.localeCompare(b.id))
  }
  const official = officialPriceRows(nowMs).map((row) => ({
    model: row.model,
    usd: row.usd,
    cny: row.cny,
    mode: row.mode,
  }))
  const fetchedAt = catalog?.fetchedAt ?? null
  return {
    revision: catalog?.revision ?? 'builtin',
    source: catalog === undefined ? 'builtin' : 'mixed',
    fetchedAt,
    nextRefreshAt: fetchedAt === null ? null : fetchedAt + PRICING_REFRESH_MS,
    usdToCny,
    official,
    providers,
    modelCount: modelCount + official.length,
  }
}

/** Create a stale-while-revalidate manager with an immutable snapshot per lookup. */
export function createPricingManager(options: PricingManagerOptions): PricingManager {
  const now = options.now ?? Date.now
  const fetchImpl = options.fetchImpl ?? fetch
  const sourceUrl = options.sourceUrl ?? MODELS_DEV_URL
  if (sourceUrl !== MODELS_DEV_URL) throw new Error('pricing source must be models.dev')
  const cachePath = join(options.home, PRICING_CACHE_RELATIVE_PATH)
  let catalog = readPricingCatalog(cachePath)
  let current = snapshotFor(catalog)
  let inFlight: Promise<PricingSnapshot> | undefined
  let lastAttempt = 0

  const refresh = async (force = false): Promise<PricingSnapshot> => {
    const timestamp = now()
    if (!force && catalog !== undefined && timestamp - catalog.fetchedAt < PRICING_REFRESH_MS) return current
    if (!force && lastAttempt !== 0 && timestamp - lastAttempt < PRICING_RETRY_MS) return current
    if (inFlight !== undefined) return inFlight
    lastAttempt = timestamp
    inFlight = (async () => {
      try {
        const response = await fetchImpl(sourceUrl, {
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw new Error(`pricing feed HTTP ${response.status}`)
        const text = await readResponseText(response)
        const parsed = JSON.parse(text) as unknown
        const sha256 = createHash('sha256').update(text).digest('hex')
        const next = normalizeModelsDevCatalog(parsed, {
          fetchedAt: now(),
          source: sourceUrl,
          sha256,
          usdToCny: options.usdToCny,
        })
        if (next === undefined) throw new Error('pricing feed schema invalid')
        writePricingCatalog(cachePath, next)
        catalog = next
        current = snapshotFor(catalog)
      } catch {
        // Keep the last valid catalog (including a stale one) or builtin prices.
      }
      return current
    })()
    try {
      return await inFlight
    } finally {
      inFlight = undefined
    }
  }

  return { snapshot: () => current, refresh, table: (nowMs = now()) => tableFor(catalog, nowMs), cachePath }
}
