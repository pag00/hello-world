// Typed helpers for every endpoint in docs/ARCHITECTURE.md. Hand-typed for now; integration replaces
// the request/response types with ones generated from the server's OpenAPI (./schema.d.ts).
// Paths marked (assumed) are not spelled out in ARCHITECTURE and must match the server.
import { apiFetch, apiRequest } from './client'
import type {
  Approval, Procedure, ProcedureRevision, PullResponse, PushResult, RevisionContent, RunCheckout,
  RunEvent, StepLock, Tool, User, Uuid, Workstation,
} from '../domain/types'
import type { AuthUser } from '../auth/types'

const enc = encodeURIComponent

export interface RunVerifyResult {
  ok: boolean
  event_count: number
  /** first event whose content or chain hash does not match, if any */
  first_bad_event_id?: Uuid | null
  errors?: string[]
}

export const api = {
  // health & auth
  health: () => apiRequest<unknown>('GET', '/health'),
  devUsers: () => apiRequest<AuthUser[]>('GET', '/auth/dev-users'),
  me: () => apiRequest<User>('GET', '/me'),
  setPin: (pin: string) => apiRequest<User | ''>('PUT', '/me/pin', { pin }),

  // sync (§7)
  push: (device_id: Uuid, events: RunEvent[]) =>
    apiRequest<{ results: PushResult[] }>('POST', '/sync/push', { device_id, events }),
  pull: (cursor: string | null, limit = 500) =>
    apiRequest<PullResponse>('GET', `/sync/pull?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`),

  // blobs
  async blobExists(sha256: string): Promise<boolean> {
    const res = await apiFetch('HEAD', `/blobs/${enc(sha256)}`)
    return res.ok
  },
  async putBlob(sha256: string, data: Blob): Promise<void> {
    await apiFetch('PUT', `/blobs/${enc(sha256)}`, {
      body: data,
      headers: { 'Content-Type': data.type || 'application/octet-stream' },
    })
  },
  async getBlob(sha256: string): Promise<Blob> {
    const res = await apiFetch('GET', `/blobs/${enc(sha256)}`)
    return res.blob()
  },

  // locks & checkout (§6)
  // device_id: the lease belongs to a device (holder_device), which the server cannot infer from the token
  lockStep: (runId: Uuid, stepId: Uuid, deviceId: Uuid, force = false) =>
    apiRequest<StepLock>('POST', `/runs/${enc(runId)}/steps/${enc(stepId)}/lock`, { device_id: deviceId, ...(force ? { force: true } : {}) }),
  heartbeat: (lockId: Uuid) => apiRequest<StepLock>('POST', `/locks/${enc(lockId)}/heartbeat`),
  releaseLock: (lockId: Uuid) => apiRequest<void>('DELETE', `/locks/${enc(lockId)}`),
  checkout: (runId: Uuid, deviceId: Uuid, hours?: number) =>
    apiRequest<RunCheckout>('POST', `/runs/${enc(runId)}/checkout`, { device_id: deviceId, ...(hours ? { hours } : {}) }),
  releaseCheckout: (runId: Uuid) => apiRequest<void>('DELETE', `/runs/${enc(runId)}/checkout`),

  // records (§10)
  verifyRun: (runId: Uuid) => apiRequest<RunVerifyResult>('GET', `/runs/${enc(runId)}/verify`),
  recordJson: (runId: Uuid) => apiRequest<unknown>('GET', `/runs/${enc(runId)}/record.json`),
  async recordPdf(runId: Uuid): Promise<Blob> {
    return (await apiFetch('GET', `/runs/${enc(runId)}/record.pdf`)).blob()
  },

  // authoring (assumed paths, §3.1 state machine is server-enforced)
  createProcedure: (input: { number: string; title: string }) =>
    apiRequest<{ procedure: Procedure; revision: ProcedureRevision }>('POST', '/procedures', input),
  createRevision: (procedureId: Uuid, change_reason: string) =>
    apiRequest<ProcedureRevision>('POST', `/procedures/${enc(procedureId)}/revisions`, { change_reason }),
  saveDraft: (revisionId: Uuid, content: RevisionContent) =>
    apiRequest<ProcedureRevision>('PUT', `/revisions/${enc(revisionId)}`, { content }),
  submitRevision: (revisionId: Uuid) => apiRequest<ProcedureRevision>('POST', `/revisions/${enc(revisionId)}/submit`),
  approveRevision: (revisionId: Uuid, comment?: string) =>
    apiRequest<ProcedureRevision>('POST', `/revisions/${enc(revisionId)}/approve`, { comment: comment ?? null }),
  rejectRevision: (revisionId: Uuid, comment: string) =>
    apiRequest<ProcedureRevision>('POST', `/revisions/${enc(revisionId)}/reject`, { comment }),
  approvals: (revisionId: Uuid) => apiRequest<Approval[]>('GET', `/revisions/${enc(revisionId)}/approvals`),

  // admin (assumed paths)
  createTool: (tool: Omit<Tool, 'id'>) => apiRequest<Tool>('POST', '/tools', tool),
  updateTool: (tool: Tool) => apiRequest<Tool>('PUT', `/tools/${enc(tool.id)}`, tool),
  upsertWorkstation: (ws: Workstation) => apiRequest<Workstation>('PUT', `/workstations/${enc(ws.code)}`, ws),
}

export type Api = typeof api
