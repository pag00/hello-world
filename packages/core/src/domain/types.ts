// Domain types — mirror of docs/ARCHITECTURE.md §3–§4.
// Wire format uses snake_case to match the server 1:1 (no mapping layer).

export type Uuid = string
/** ISO-8601 UTC timestamp with milliseconds and 'Z', e.g. 2026-10-22T10:31:05.123Z */
export type IsoTs = string
/** Decimal number encoded as string, e.g. "12.50". Floats are forbidden in hashed content. */
export type DecimalString = string
/** "sha256:<64 hex>" */
export type Sha256Ref = string

export type Role = 'operator' | 'inspector' | 'author' | 'approver' | 'supervisor' | 'admin'

export interface User {
  id: Uuid
  name: string
  email?: string | null
  roles: Role[]
  /** "pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>" — present when user has set an offline PIN */
  pin_verifier?: string | null
}

// ---------------------------------------------------------------------------
// Procedures

export type RevisionStatus = 'draft' | 'in_review' | 'released' | 'obsolete'

export interface Procedure {
  id: Uuid
  number: string
  title: string
  created_at: IsoTs
}

export interface ProcedureRevision {
  id: Uuid
  procedure_id: Uuid
  rev: string
  status: RevisionStatus
  content: RevisionContent
  content_hash: Sha256Ref | null
  change_reason: string | null
  author_id: Uuid
  created_at: IsoTs
  submitted_at: IsoTs | null
  released_at: IsoTs | null
  obsoleted_at: IsoTs | null
}

export interface Approval {
  id: Uuid
  revision_id: Uuid
  approver_id: Uuid
  decision: 'approve' | 'reject'
  comment: string | null
  signed_at: IsoTs
}

export interface RevisionContent {
  schema: 1
  sections: Section[]
}

export interface Section {
  id: Uuid
  title: string
  steps: Step[]
}

export interface Step {
  id: Uuid
  title: string
  instructions: string
  media: Sha256Ref[]
  locations: string[]
  depends_on: Uuid[]
  verification?: { required: boolean; role: Role } | null
  inputs: Input[]
}

interface InputBase {
  id: Uuid
  label: string
  required: boolean
}

export interface CheckInput extends InputBase { type: 'check' }
export interface TextInput extends InputBase { type: 'text'; multiline?: boolean }
export interface NumberInput extends InputBase {
  type: 'number'
  unit: string
  min?: DecimalString | null
  nominal?: DecimalString | null
  max?: DecimalString | null
  decimals: number
  ocr: boolean
}
export interface PhotoInput extends InputBase { type: 'photo'; min_count: number; max_count?: number | null }
export interface ScanInput extends InputBase {
  type: 'scan'
  entity: 'part' | 'tool' | 'any'
  /** exact value, or a regex when wrapped in slashes: "/^PN-123-\\d+$/" */
  expect?: string | null
}
export interface SignoffInput extends InputBase { type: 'signoff'; role?: Role | null }

export type Input = CheckInput | TextInput | NumberInput | PhotoInput | ScanInput | SignoffInput
export type InputType = Input['type']

/** Value recorded per input type (see ARCHITECTURE §3.2). */
export type InputValue = true | string | Sha256Ref[]

// ---------------------------------------------------------------------------
// Runs & events

export type RunStatus = 'active' | 'blocked' | 'completed' | 'aborted'

export interface Run {
  id: Uuid
  procedure_id: Uuid
  revision_id: Uuid
  serial: string
  work_order: string | null
  status: RunStatus
  created_by: Uuid
  created_at: IsoTs
  closed_at: IsoTs | null
}

export type EventType =
  | 'run.created'
  | 'step.started'
  | 'input.recorded'
  | 'step.completed'
  | 'step.verified'
  | 'step.reopened'
  | 'note.added'
  | 'ncr.raised'
  | 'ncr.dispositioned'
  | 'ncr.closed'
  | 'conflict.resolved'
  | 'run.completed'
  | 'run.aborted'

export type EventFlag =
  | 'conflict'
  | 'unlocked'
  | 'late_lock'
  | 'tool_expired'
  | 'tool_unknown'
  | 'blob_missing'
  | 'out_of_tolerance'

export type AuthMethod = 'oidc' | 'pin'

export interface EventPayloads {
  'run.created': { procedure_id: Uuid; revision_id: Uuid; serial: string; work_order: string | null }
  'step.started': Record<string, never>
  'input.recorded': { input_id: Uuid; value: InputValue; source: 'manual' | 'ocr' | 'scan'; ocr_raw?: string }
  'step.completed': Record<string, never>
  'step.verified': Record<string, never>
  'step.reopened': { reason: string }
  'note.added': { text: string; system?: 'lock_takeover' }
  'ncr.raised': { ncr_id: Uuid; number?: string; description: string; input_id?: Uuid }
  'ncr.dispositioned': { ncr_id: Uuid; disposition: NcrDisposition; note: string }
  'ncr.closed': { ncr_id: Uuid }
  'conflict.resolved': { kept_event_ids: Uuid[]; rejected_event_ids: Uuid[]; reason: string }
  'run.completed': Record<string, never>
  'run.aborted': { reason: string }
}

/** Fields the client sets and that are covered by content_hash. */
export interface RunEventContent<T extends EventType = EventType> {
  id: Uuid
  run_id: Uuid
  type: T
  step_id: Uuid | null
  payload: EventPayloads[T]
  actor_id: Uuid
  auth_method: AuthMethod
  device_id: Uuid
  client_ts: IsoTs
  offline: boolean
  supersedes: Uuid | null
}

export interface RunEvent<T extends EventType = EventType> extends RunEventContent<T> {
  content_hash: Sha256Ref
  // server-assigned (absent until pushed & accepted)
  seq?: number | null
  prev_chain_hash?: Sha256Ref | null
  chain_hash?: Sha256Ref | null
  server_ts?: IsoTs | null
  flags?: EventFlag[]
}

// ---------------------------------------------------------------------------
// Projection

export type StepState = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'verified' | 'conflict'

export type BlockReason = 'depends_on' | 'out_of_tolerance' | 'tool_expired' | 'tool_unknown' | 'open_ncr'

export interface InputProjection {
  input_id: Uuid
  value: InputValue | null
  event_id: Uuid | null
  out_of_tolerance: boolean
  /** non-superseded competing event ids when the step is in conflict */
  competing_event_ids: Uuid[]
}

export interface StepProjection {
  step_id: Uuid
  state: StepState
  block_reasons: BlockReason[]
  inputs: Record<Uuid, InputProjection>
  completed_by: Uuid | null
  completed_at: IsoTs | null
  verified_by: Uuid | null
  verified_at: IsoTs | null
  open_ncr_ids: Uuid[]
}

export interface RunProjection {
  run_id: Uuid
  status: RunStatus
  steps: Record<Uuid, StepProjection>
  open_ncr_ids: Uuid[]
  /** true when every step is completed (and verified where required), no open NCR, no conflict */
  can_complete: boolean
}

// ---------------------------------------------------------------------------
// Supporting entities

export type NcrStatus = 'open' | 'dispositioned' | 'closed'
export type NcrDisposition = 'use_as_is' | 'rework' | 'repair' | 'scrap' | 'return_to_supplier'

export interface Ncr {
  id: Uuid
  run_id: Uuid
  step_id: Uuid | null
  input_id: Uuid | null
  number: string | null
  description: string
  status: NcrStatus
  disposition: NcrDisposition | null
  disposition_note: string | null
  raised_by: Uuid
  raised_at: IsoTs
  dispositioned_by: Uuid | null
  dispositioned_at: IsoTs | null
  closed_by: Uuid | null
  closed_at: IsoTs | null
}

export interface Tool {
  id: Uuid
  code: string
  description: string
  calibration_due: string | null // YYYY-MM-DD; null = no calibration required
  active: boolean
}

export interface Workstation {
  code: string
  name: string
}

export interface BlobMeta {
  sha256: string // hex, without prefix
  size: number
  mime: string
  created_at: IsoTs
}

// ---------------------------------------------------------------------------
// Locks & sync

export interface StepLock {
  lock_id: Uuid
  run_id: Uuid
  step_id: Uuid
  holder_user: Uuid
  holder_device: Uuid
  expires_at: IsoTs
}

export interface RunCheckout {
  run_id: Uuid
  holder_user: Uuid
  holder_device: Uuid
  expires_at: IsoTs
}

export interface PushResult {
  id: Uuid
  status: 'accepted' | 'duplicate' | 'rejected'
  seq?: number | null
  flags?: EventFlag[]
  error?: string | null
}

export interface PullResponse {
  cursor: string
  has_more: boolean
  procedures: Procedure[]
  revisions: ProcedureRevision[]
  runs: Run[]
  events: RunEvent[]
  tools: Tool[]
  workstations: Workstation[]
  ncrs: Ncr[]
  users: User[]
}

// ---------------------------------------------------------------------------
// QR

export type QrTarget =
  | { kind: 'workstation'; code: string }
  | { kind: 'run'; run_id: Uuid }
  | { kind: 'part'; part_number: string; serial: string }
  | { kind: 'tool'; code: string }
  | { kind: 'unknown'; raw: string }
