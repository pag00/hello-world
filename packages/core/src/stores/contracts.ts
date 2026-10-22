// Store contracts consumed by UI components. Implementations live in ./session.ts, ./procedures.ts,
// ./runs.ts, ./registry.ts, ./sync.ts (Pinia setup stores). UI code imports hooks from '@/stores'.
import type { ComputedRef, Ref } from 'vue'
import type {
  InputValue, Ncr, NcrDisposition, Procedure, ProcedureRevision, RevisionContent, Role, Run,
  RunEvent, RunProjection, Sha256Ref, StepLock, RunCheckout, Tool, User, Uuid, Workstation,
} from '../domain/types'

/** Who signs an event. Defaults to the logged-in user (oidc); PIN signers come from SessionStore.verifyPin. */
export interface Signer {
  user: User
  auth_method: 'oidc' | 'pin'
}

export type EditCheck = { ok: true } | { ok: false; reason: 'offline_not_checked_out' | 'locked_by_other' | 'not_locked' | 'run_closed' | 'checked_out_by_other' }

export interface SessionStore {
  user: Ref<User | null>
  deviceId: Ref<Uuid>
  online: Ref<boolean>
  /** users that confirmed their PIN on this device during this session (for countersign) */
  pinSigners: Ref<User[]>
  init(): Promise<void>
  login(): Promise<void>
  logout(): Promise<void>
  hasRole(role: Role, user?: User | null): boolean
  /** verify offline PIN against cached pin_verifier; on success adds to pinSigners and returns a Signer */
  verifyPin(userId: Uuid, pin: string): Promise<Signer | null>
  /** set/replace own PIN (online only) */
  setPin(pin: string): Promise<void>
  defaultSigner(): Signer
}

export interface ProceduresStore {
  procedures: Ref<Procedure[]>
  revisions: Ref<ProcedureRevision[]>
  revisionsOf(procedureId: Uuid): ProcedureRevision[]
  releasedRevision(procedureId: Uuid): ProcedureRevision | null
  getRevision(revisionId: Uuid): ProcedureRevision | null
  // authoring — online only, call the server directly then refresh local cache
  createProcedure(input: { number: string; title: string }): Promise<{ procedure: Procedure; revision: ProcedureRevision }>
  createRevision(procedureId: Uuid, changeReason: string): Promise<ProcedureRevision>
  saveDraft(revisionId: Uuid, content: RevisionContent): Promise<ProcedureRevision>
  submit(revisionId: Uuid): Promise<ProcedureRevision>
  approve(revisionId: Uuid, comment?: string): Promise<ProcedureRevision>
  reject(revisionId: Uuid, comment: string): Promise<ProcedureRevision>
  approvalsOf(revisionId: Uuid): Promise<import('../domain/types').Approval[]>
}

export interface RecordInputArgs {
  runId: Uuid
  stepId: Uuid
  inputId: Uuid
  value: InputValue
  source: 'manual' | 'ocr' | 'scan'
  ocrRaw?: string
  supersedes?: Uuid | null
  signer?: Signer
}

export interface RunsStore {
  runs: Ref<Run[]>
  /** run the tablet is currently working on (used for workstation QR resolution) */
  activeRunId: Ref<Uuid | null>
  events(runId: Uuid): RunEvent[]
  projection(runId: Uuid): ComputedRef<RunProjection | null>
  startRun(input: { revisionId: Uuid; serial: string; workOrder?: string | null }): Promise<Run>
  recordInput(args: RecordInputArgs): Promise<RunEvent>
  startStep(runId: Uuid, stepId: Uuid, signer?: Signer): Promise<RunEvent>
  completeStep(runId: Uuid, stepId: Uuid, signer?: Signer): Promise<RunEvent>
  verifyStep(runId: Uuid, stepId: Uuid, signer: Signer): Promise<RunEvent>
  reopenStep(runId: Uuid, stepId: Uuid, reason: string, signer?: Signer): Promise<RunEvent>
  addNote(runId: Uuid, stepId: Uuid | null, text: string, signer?: Signer): Promise<RunEvent>
  raiseNcr(input: { runId: Uuid; stepId: Uuid | null; inputId?: Uuid | null; description: string; signer?: Signer }): Promise<RunEvent>
  dispositionNcr(input: { runId: Uuid; ncrId: Uuid; disposition: NcrDisposition; note: string; signer?: Signer }): Promise<RunEvent>
  closeNcr(runId: Uuid, ncrId: Uuid, signer?: Signer): Promise<RunEvent>
  resolveConflict(input: { runId: Uuid; stepId: Uuid; keep: Uuid[]; reject: Uuid[]; reason: string }): Promise<RunEvent>
  completeRun(runId: Uuid): Promise<RunEvent>
  abortRun(runId: Uuid, reason: string): Promise<RunEvent>
  /** validation per ARCHITECTURE §4 "Validation on write" — returns i18n keys of problems, empty = ok */
  validateComplete(runId: Uuid, stepId: Uuid): string[]
  // concurrency (ARCHITECTURE §6)
  canEdit(runId: Uuid, stepId: Uuid): EditCheck
  lockStep(runId: Uuid, stepId: Uuid, opts?: { force?: boolean }): Promise<StepLock>
  releaseStep(runId: Uuid, stepId: Uuid): Promise<void>
  locks(runId: Uuid): StepLock[]
  checkout(runId: Uuid, hours?: number): Promise<RunCheckout>
  releaseCheckout(runId: Uuid): Promise<void>
  checkoutOf(runId: Uuid): RunCheckout | null
}

export interface RegistryStore {
  tools: Ref<Tool[]>
  workstations: Ref<Workstation[]>
  users: Ref<User[]>
  ncrs: Ref<Ncr[]>
  userName(id: Uuid | null | undefined): string
  checkTool(code: string, on?: Date): { status: 'ok' | 'expired' | 'unknown' | 'inactive'; tool: Tool | null }
  // admin — online only
  upsertTool(tool: Omit<Tool, 'id'> & { id?: Uuid }): Promise<Tool>
  upsertWorkstation(ws: Workstation): Promise<Workstation>
}

export interface BlobStore {
  /** hash, store locally, enqueue upload; returns "sha256:<hex>" */
  put(blob: Blob): Promise<Sha256Ref>
  /** object URL from local cache, fetching from server if missing (online) */
  url(ref: Sha256Ref): Promise<string | null>
}

export interface SyncStore {
  syncing: Ref<boolean>
  lastSyncAt: Ref<string | null>
  pendingEvents: Ref<number>
  pendingBlobs: Ref<number>
  lastError: Ref<string | null>
  syncNow(): Promise<void>
}
