/** Shared Host/browser contract for dsh-whale-pet. */

export const WHALE_PET_PATHS = {
  health: '/api/whale-pet/health',
  state: '/api/whale-pet/state',
  tasks: '/api/whale-pet/tasks',
  taskSummary: '/api/whale-pet/task-summary',
  pricing: '/api/whale-pet/pricing',
  openCodeGo: '/api/whale-pet/opencode-go',
  companions: '/api/whale-pet/companions',
  companionIssue: '/api/whale-pet/companions/issue',
  companionRevoke: '/api/whale-pet/companions/revoke',
  companionState: '/dsh-whale-pet/companion/v1/state',
  companionTasks: '/dsh-whale-pet/companion/v1/tasks',
  companionTaskSummary: '/dsh-whale-pet/companion/v1/task-summary',
  companionOpenCodeGo: '/dsh-whale-pet/companion/v1/opencode-go',
  live2d: '/dsh-whale-pet-live2d.js',
  live2dZipWorker: '/dsh-whale-pet-live2d-zip-worker.js',
  cubismCore: '/dsh-whale-pet-live2dcubismcore.min.js',
} as const

export const MAX_REQUEST_BODY_BYTES = 64 * 1024
export const MAX_TASK_IDS = 32
export const MAX_SESSION_ID_LENGTH = 256

export type WhalePetErrorCode =
  | 'bad-json'
  | 'bad-request'
  | 'payload-too-large'
  | 'session-log-corrupt'
  | 'internal'

export interface WhalePetErrorBody {
  readonly ok: false
  readonly error: WhalePetErrorCode
  readonly message: string
}
