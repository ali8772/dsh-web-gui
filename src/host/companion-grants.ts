import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import {
  credentialKey,
  type CredentialKey,
  type CredentialRecord,
} from '@deepseek-ai/dsh-credentials'

const RECORD_KEY: CredentialKey = credentialKey('dsh-whale-pet', 'companion-grants')
const TOKEN_PREFIX = 'wpg1'
const DIGEST_DOMAIN = 'dsh-whale-pet/grant/v1\0'
const MAX_GRANTS = 32
const MAX_LABEL_LENGTH = 80

export interface CompanionGrantView {
  readonly id: string
  readonly label: string
  readonly createdAt: number
}

interface StoredGrant extends CompanionGrantView {
  readonly digest: string
}

interface GrantsPayload {
  readonly v: 1
  readonly grants: readonly StoredGrant[]
}

export interface CompanionGrantRecords {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
  deleteRecord?(key: CredentialKey): Promise<void>
}

export interface CompanionGrants {
  list(): Promise<readonly CompanionGrantView[]>
  issue(label: string): Promise<{ grant: CompanionGrantView; token: string }>
  revoke(id: string): Promise<boolean>
  authenticate(remoteAddress: string | undefined, authorization: string | readonly string[] | undefined): Promise<CompanionGrantView | null>
}

function canonicalBase64Url(value: string, bytes: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) return undefined
  return decoded
}

function digest(id: string, secret: Buffer): Buffer {
  return createHash('sha256')
    .update(DIGEST_DOMAIN, 'utf8')
    .update(id, 'utf8')
    .update('\0', 'utf8')
    .update(secret)
    .digest()
}

function parseStoredGrant(value: unknown): StoredGrant | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const grant = value as Partial<StoredGrant>
  if (typeof grant.id !== 'string' || canonicalBase64Url(grant.id, 16) === undefined) return undefined
  if (typeof grant.label !== 'string' || grant.label.length === 0 || grant.label.length > MAX_LABEL_LENGTH) return undefined
  if (typeof grant.createdAt !== 'number' || !Number.isSafeInteger(grant.createdAt) || grant.createdAt < 0) return undefined
  if (typeof grant.digest !== 'string' || canonicalBase64Url(grant.digest, 32) === undefined) return undefined
  return { id: grant.id, label: grant.label, createdAt: grant.createdAt, digest: grant.digest }
}

function parsePayload(record: CredentialRecord | undefined): GrantsPayload {
  if (record === undefined) return { v: 1, grants: [] }
  if (record.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object') {
    throw new Error('companion grant record has an unsupported format')
  }
  const payload = record.payload as Partial<GrantsPayload>
  if (payload.v !== 1 || !Array.isArray(payload.grants) || payload.grants.length > MAX_GRANTS) {
    throw new Error('companion grant record has an unsupported format')
  }
  const grants = payload.grants.map(parseStoredGrant)
  if (grants.some((grant) => grant === undefined)) throw new Error('companion grant record is invalid')
  const ids = new Set(grants.map((grant) => grant!.id))
  if (ids.size !== grants.length) throw new Error('companion grant record repeats an id')
  return { v: 1, grants: grants as StoredGrant[] }
}

function view(grant: StoredGrant): CompanionGrantView {
  return { id: grant.id, label: grant.label, createdAt: grant.createdAt }
}

function header(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isTrustedCompanionRequest(headers: IncomingHttpHeaders): boolean {
  const host = header(headers.host)
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') return false
  if (header(headers['sec-fetch-site']) === 'cross-site') return false
  const origin = header(headers.origin)
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

export function isCompanionLoopback(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  if (remoteAddress === '::1') return true
  const address = remoteAddress.toLowerCase().startsWith('::ffff:')
    ? remoteAddress.slice(7)
    : remoteAddress
  const octets = address.split('.')
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
    && octets[0] === '127'
}

function parseBearer(value: string | readonly string[] | undefined): { id: string; secret: Buffer } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^Bearer (wpg1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43}))$/u.exec(value)
  if (match === null) return undefined
  const id = match[2]!
  const secretText = match[3]!
  if (canonicalBase64Url(id, 16) === undefined) return undefined
  const secret = canonicalBase64Url(secretText, 32)
  return secret === undefined ? undefined : { id, secret }
}

export function createCompanionGrants(records: CompanionGrantRecords): CompanionGrants {
  return {
    async list(): Promise<readonly CompanionGrantView[]> {
      return parsePayload(await records.readRecord(RECORD_KEY)).grants.map(view)
    },

    async issue(rawLabel: string): Promise<{ grant: CompanionGrantView; token: string }> {
      const label = rawLabel.trim()
      if (label.length === 0 || label.length > MAX_LABEL_LENGTH) throw new Error('companion label must be 1-80 characters')
      const id = randomBytes(16).toString('base64url')
      const secret = randomBytes(32)
      const createdAt = Date.now()
      const stored: StoredGrant = { id, label, createdAt, digest: digest(id, secret).toString('base64url') }
      await records.modifyRecord(RECORD_KEY, async (current) => {
        const payload = parsePayload(current)
        if (payload.grants.length >= MAX_GRANTS) throw new Error(`at most ${MAX_GRANTS} companion grants are allowed`)
        return { kind: 'grant', payload: { v: 1, grants: [...payload.grants, stored] } }
      })
      return { grant: view(stored), token: `${TOKEN_PREFIX}.${id}.${secret.toString('base64url')}` }
    },

    async revoke(id: string): Promise<boolean> {
      let removed = false
      await records.modifyRecord(RECORD_KEY, async (current) => {
        const payload = parsePayload(current)
        const grants = payload.grants.filter((grant) => grant.id !== id)
        removed = grants.length !== payload.grants.length
        return removed ? { kind: 'grant', payload: { v: 1, grants } } : undefined
      })
      return removed
    },

    async authenticate(remoteAddress, authorization): Promise<CompanionGrantView | null> {
      if (!isCompanionLoopback(remoteAddress)) return null
      const bearer = parseBearer(authorization)
      if (bearer === undefined) return null
      const stored = parsePayload(await records.readRecord(RECORD_KEY)).grants.find((grant) => grant.id === bearer.id)
      if (stored === undefined) return null
      const expected = canonicalBase64Url(stored.digest, 32)
      if (expected === undefined) return null
      const actual = digest(bearer.id, bearer.secret)
      return timingSafeEqual(expected, actual) ? view(stored) : null
    },
  }
}
