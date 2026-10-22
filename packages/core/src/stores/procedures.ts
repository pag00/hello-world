import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProceduresStore } from './contracts'
import type { Approval, Procedure, ProcedureRevision, Uuid } from '../domain/types'
import { OfflineError } from '../api/client'
import { api } from '../api/endpoints'
import { getDb, syncState } from '../sync/runtime'

export interface ProceduresStoreImpl extends ProceduresStore {
  hydrate(): Promise<void>
}

function byCreated<T extends { created_at: string }>(a: T, b: T) {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}

export const useProceduresStore = defineStore('st-procedures', (): ProceduresStoreImpl => {
  const procedures = ref<Procedure[]>([])
  const revisions = ref<ProcedureRevision[]>([])

  async function hydrate() {
    const db = getDb()
    const [p, r] = await Promise.all([db.procedures.toArray(), db.revisions.toArray()])
    procedures.value = p.sort((a, b) => a.number.localeCompare(b.number))
    revisions.value = r.sort(byCreated)
  }

  function requireOnline() {
    if (!syncState.online.value) throw new OfflineError()
  }

  async function upsertProcedure(p: Procedure) {
    await getDb().procedures.put(p)
    const rest = procedures.value.filter((x) => x.id !== p.id)
    procedures.value = [...rest, p].sort((a, b) => a.number.localeCompare(b.number))
  }

  async function upsertRevision(r: ProcedureRevision): Promise<ProcedureRevision> {
    await getDb().revisions.put(r)
    revisions.value = [...revisions.value.filter((x) => x.id !== r.id), r].sort(byCreated)
    return r
  }

  /** Approve/submit may change other revisions (release obsoletes the previous one): re-read them. */
  async function upsertAndRefreshSiblings(r: ProcedureRevision): Promise<ProcedureRevision> {
    await upsertRevision(r)
    if (r.status === 'released') {
      const now = new Date().toISOString()
      for (const other of revisions.value.filter((x) => x.procedure_id === r.procedure_id && x.id !== r.id && x.status === 'released')) {
        // mirror the server transition locally until the next pull brings the authoritative row
        await upsertRevision({ ...other, status: 'obsolete', obsoleted_at: other.obsoleted_at ?? now })
      }
    }
    return r
  }

  return {
    procedures,
    revisions,
    hydrate,
    revisionsOf: (id: Uuid) => revisions.value.filter((r) => r.procedure_id === id),
    releasedRevision: (id: Uuid) => revisions.value.find((r) => r.procedure_id === id && r.status === 'released') ?? null,
    getRevision: (id: Uuid) => revisions.value.find((r) => r.id === id) ?? null,

    async createProcedure(input) {
      requireOnline()
      const res = await api.createProcedure({ number: input.number.trim(), title: input.title.trim() })
      await upsertProcedure(res.procedure)
      await upsertRevision(res.revision)
      return res
    },
    async createRevision(procedureId, changeReason) {
      requireOnline()
      return upsertRevision(await api.createRevision(procedureId, changeReason))
    },
    async saveDraft(revisionId, content) {
      requireOnline()
      return upsertRevision(await api.saveDraft(revisionId, content))
    },
    async submit(revisionId) {
      requireOnline()
      return upsertRevision(await api.submitRevision(revisionId))
    },
    async approve(revisionId, comment) {
      requireOnline()
      return upsertAndRefreshSiblings(await api.approveRevision(revisionId, comment))
    },
    async reject(revisionId, comment) {
      requireOnline()
      return upsertRevision(await api.rejectRevision(revisionId, comment))
    },
    async approvalsOf(revisionId): Promise<Approval[]> {
      requireOnline()
      return api.approvals(revisionId)
    },
  }
})
