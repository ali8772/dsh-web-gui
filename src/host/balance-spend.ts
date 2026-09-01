import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { shanghaiDay, spendWindowDays } from './sessions.ts'

const STATE_VERSION = 2
const HISTORY_DAYS = 35
const STATE_RELATIVE_PATH = join('whale-pet', 'balance-spend.json')

interface Ledger {
  readonly lastBalanceMinor: number
  readonly byDayMinor: Record<string, number>
}

interface StoredBalanceSpend {
  readonly version: 2
  readonly lastCurrency: string
  readonly ledgers: Record<string, Ledger>
}

export interface BalanceObservation {
  readonly currency: string
  readonly totalBalance: number
}

export interface BalanceSpendSnapshot {
  readonly currency: string | null
  readonly today: number
  readonly days7: number
  readonly byDay: Readonly<Record<string, number>>
}

const stateCache = new Map<string, StoredBalanceSpend>()

function emptyLedger(balanceMinor: number): Ledger {
  return { lastBalanceMinor: balanceMinor, byDayMinor: {} }
}

function emptyState(): StoredBalanceSpend {
  return { version: STATE_VERSION, lastCurrency: '', ledgers: {} }
}

function validMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseLedger(value: unknown): Ledger | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Partial<Ledger>
  if (!validMinor(record.lastBalanceMinor)) return undefined
  if (record.byDayMinor === null || typeof record.byDayMinor !== 'object' || Array.isArray(record.byDayMinor)) return undefined
  const byDayMinor: Record<string, number> = {}
  for (const [day, amount] of Object.entries(record.byDayMinor)) {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(day) && validMinor(amount)) byDayMinor[day] = amount
  }
  return { lastBalanceMinor: record.lastBalanceMinor, byDayMinor }
}

function parseState(value: unknown): StoredBalanceSpend | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Partial<StoredBalanceSpend>
  if (record.version !== STATE_VERSION) return undefined
  if (typeof record.lastCurrency !== 'string') return undefined
  if (record.ledgers === null || typeof record.ledgers !== 'object' || Array.isArray(record.ledgers)) return undefined
  const ledgers: Record<string, Ledger> = {}
  for (const [currency, ledger] of Object.entries(record.ledgers)) {
    if (currency === '' || ledger === null || typeof ledger !== 'object') continue
    const parsed = parseLedger(ledger)
    if (parsed !== undefined) ledgers[currency] = parsed
  }
  return { version: STATE_VERSION, lastCurrency: record.lastCurrency, ledgers }
}

function cloneState(state: StoredBalanceSpend): StoredBalanceSpend {
  const ledgers: Record<string, Ledger> = {}
  for (const [currency, ledger] of Object.entries(state.ledgers)) {
    ledgers[currency] = { lastBalanceMinor: ledger.lastBalanceMinor, byDayMinor: { ...ledger.byDayMinor } }
  }
  return { version: STATE_VERSION, lastCurrency: state.lastCurrency, ledgers }
}

function loadState(path: string): StoredBalanceSpend | undefined {
  const cached = stateCache.get(path)
  if (cached !== undefined) return cloneState(cached)
  try {
    const parsed = parseState(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    if (parsed !== undefined) stateCache.set(path, parsed)
    return parsed !== undefined ? cloneState(parsed) : undefined
  } catch {
    return undefined
  }
}

function saveState(path: string, state: StoredBalanceSpend): void {
  stateCache.set(path, state)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`)
      closeSync(fd)
      renameSync(temporary, path)
    } catch (error) {
      try { closeSync(fd) } catch { /* ignore */ }
      throw error
    } finally {
      try { unlinkSync(temporary) } catch { /* already moved or gone */ }
    }
  } catch {
    // A persistence failure must not fail the route: the in-memory ledger stays
    // authoritative for this process. Log it so operators can investigate.
    console.warn('dsh-whale-pet: failed to persist balance spend state')
  }
}

function toMinor(amount: number): number | undefined {
  if (!Number.isFinite(amount) || amount < 0) return undefined
  const minor = Math.round(amount * 100)
  return Number.isSafeInteger(minor) ? minor : undefined
}

function fromMinor(minor: number): number {
  return Math.round(minor) / 100
}

function pruneHistory(ledger: Ledger, nowMs: number): void {
  const oldest = shanghaiDay(nowMs - (HISTORY_DAYS - 1) * 86_400_000)
  for (const day of Object.keys(ledger.byDayMinor)) {
    if (day < oldest) delete ledger.byDayMinor[day]
  }
}

function snapshot(state: StoredBalanceSpend | undefined, currency: string | null, nowMs: number): BalanceSpendSnapshot {
  if (state === undefined || currency === null) return { currency, today: 0, days7: 0, byDay: {} }
  const ledger = state.ledgers[currency]
  if (ledger === undefined) return { currency, today: 0, days7: 0, byDay: {} }
  const { startDay, endDay } = spendWindowDays(nowMs, 7)
  let todayMinor = 0
  let days7Minor = 0
  const byDay: Record<string, number> = {}
  for (const [day, minor] of Object.entries(ledger.byDayMinor).sort(([a], [b]) => a.localeCompare(b))) {
    byDay[day] = fromMinor(minor)
    if (day === endDay) todayMinor += minor
    if (day >= startDay && day <= endDay) days7Minor += minor
  }
  return {
    currency,
    today: fromMinor(todayMinor),
    days7: fromMinor(days7Minor),
    byDay,
  }
}

/**
 * Record one authoritative balance observation.
 *
 * The first observation of a currency establishes that currency's baseline.
 * Later balance decreases are accumulated as spend on the current Beijing
 * calendar day. Balance increases (top-ups or grants) update the baseline but
 * never reduce accumulated spend. Each currency keeps an independent ledger;
 * switching the active currency never deletes another currency's history.
 * State is persisted under `$DSH_HOME/whale-pet/balance-spend.json`.
 */
export function observeBalanceSpend(
  home: string,
  observation: BalanceObservation | null,
  nowMs = Date.now(),
): BalanceSpendSnapshot {
  const path = join(home, STATE_RELATIVE_PATH)
  const state = loadState(path)
  if (observation === null) {
    const active = state !== undefined && state.lastCurrency !== '' ? state.lastCurrency : null
    return snapshot(state, active, nowMs)
  }

  const balanceMinor = toMinor(observation.totalBalance)
  const currency = observation.currency.trim()
  if (balanceMinor === undefined || currency === '') return snapshot(state, null, nowMs)

  if (state === undefined) {
    const fresh: StoredBalanceSpend = { version: STATE_VERSION, lastCurrency: currency, ledgers: { [currency]: emptyLedger(balanceMinor) } }
    saveState(path, fresh)
    return snapshot(fresh, currency, nowMs)
  }

  const next = cloneState(state)
  const currencyChanged = next.lastCurrency !== currency
  if (currencyChanged) next.lastCurrency = currency
  const ledger = next.ledgers[currency] ?? emptyLedger(balanceMinor)
  next.ledgers[currency] = ledger
  pruneHistory(ledger, nowMs)
  const decreaseMinor = ledger.lastBalanceMinor - balanceMinor
  if (decreaseMinor > 0) {
    const day = shanghaiDay(nowMs)
    ledger.byDayMinor[day] = (ledger.byDayMinor[day] ?? 0) + decreaseMinor
  }
  if (ledger.lastBalanceMinor !== balanceMinor || decreaseMinor > 0 || currencyChanged) {
    ledger.lastBalanceMinor = balanceMinor
    saveState(path, next)
  }
  return snapshot(next, currency, nowMs)
}
