// Revision list logic for the procedure page: ordering, the baseline a revision is compared against,
// and which state-machine actions (ARCHITECTURE §3.1) the current user may be offered.
// The server enforces all of this again; the client only decides what to show.
import type { ProcedureRevision, Role, User } from '../../domain/types'

/** Revision letters sort A..Z, AA..; creation time breaks ties and orders anything unusual. */
export function compareRev(a: ProcedureRevision, b: ProcedureRevision): number {
  if (a.rev.length !== b.rev.length) return a.rev.length - b.rev.length
  if (a.rev !== b.rev) return a.rev < b.rev ? -1 : 1
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}

export function sortRevisions(list: readonly ProcedureRevision[]): ProcedureRevision[] {
  return [...list].sort(compareRev)
}

/** The released (or since obsoleted) revision immediately before `rev` — what approvers compare against. */
export function baselineOf(rev: ProcedureRevision, all: readonly ProcedureRevision[]): ProcedureRevision | null {
  const earlier = sortRevisions(all.filter((r) => r.procedure_id === rev.procedure_id && r.id !== rev.id && compareRev(r, rev) < 0))
  for (let i = earlier.length - 1; i >= 0; i--) {
    const r = earlier[i]!
    if (r.status === 'released' || r.status === 'obsolete') return r
  }
  return null
}

export interface RevisionActions {
  edit: boolean
  submit: boolean
  approve: boolean
  reject: boolean
  startRun: boolean
  /** shown on the procedure, not a revision: no open draft/in_review exists */
  newRevision: boolean
}

const has = (u: User | null, r: Role) => !!u && u.roles.includes(r)

export function revisionActions(rev: ProcedureRevision, all: readonly ProcedureRevision[], user: User | null, online: boolean): RevisionActions {
  const isAuthor = !!user && user.id === rev.author_id
  return {
    edit: online && has(user, 'author') && rev.status === 'draft',
    submit: online && has(user, 'author') && rev.status === 'draft',
    // never offered on one's own revision (§2)
    approve: online && has(user, 'approver') && rev.status === 'in_review' && !isAuthor,
    reject: online && has(user, 'approver') && rev.status === 'in_review' && !isAuthor,
    startRun: rev.status === 'released',
    newRevision: canCreateRevision(all, user, online),
  }
}

export function openRevision(all: readonly ProcedureRevision[]): ProcedureRevision | null {
  return all.find((r) => r.status === 'draft' || r.status === 'in_review') ?? null
}

export function canCreateRevision(all: readonly ProcedureRevision[], user: User | null, online: boolean): boolean {
  return online && has(user, 'author') && all.length > 0 && !openRevision(all)
}

export function shortHash(h: string | null | undefined, n = 12): string {
  if (!h) return '—'
  return h.replace(/^sha256:/, '').slice(0, n)
}
