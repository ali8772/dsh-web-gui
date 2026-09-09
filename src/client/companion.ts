import { WHALE_PET_PATHS } from '../shared/contract.ts'

export interface CompanionGrant {
  readonly id: string
  readonly label: string
  readonly createdAt: number
}

export interface IssuedCompanionGrant {
  readonly grant: CompanionGrant
  readonly token: string
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as unknown
  if (!response.ok || body === null || typeof body !== 'object') throw new Error(`HTTP ${response.status}`)
  return body as Record<string, unknown>
}

export async function listCompanionGrants(signal?: AbortSignal): Promise<readonly CompanionGrant[]> {
  const response = await fetch(WHALE_PET_PATHS.companions, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  })
  const body = await responseJson(response)
  return Array.isArray(body.grants) ? body.grants as CompanionGrant[] : []
}

export async function issueCompanionGrant(label: string, signal?: AbortSignal): Promise<IssuedCompanionGrant> {
  const response = await fetch(WHALE_PET_PATHS.companionIssue, {
    method: 'POST',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
    signal,
  })
  const body = await responseJson(response)
  if (body.grant === null || typeof body.grant !== 'object' || typeof body.token !== 'string') {
    throw new Error('invalid companion issue response')
  }
  return { grant: body.grant as CompanionGrant, token: body.token }
}

export async function revokeCompanionGrant(id: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(WHALE_PET_PATHS.companionRevoke, {
    method: 'POST',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
    signal,
  })
  await responseJson(response)
}
