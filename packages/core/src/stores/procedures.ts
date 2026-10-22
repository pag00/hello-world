import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ProceduresStore } from './contracts'
import type { Procedure, ProcedureRevision } from '../domain/types'
import { notImplemented } from './_stub'

export const useProceduresStore = defineStore('st-procedures', (): ProceduresStore => {
  const procedures = ref<Procedure[]>([])
  const revisions = ref<ProcedureRevision[]>([])
  return {
    procedures,
    revisions,
    revisionsOf: (id) => revisions.value.filter((r) => r.procedure_id === id),
    releasedRevision: (id) => revisions.value.find((r) => r.procedure_id === id && r.status === 'released') ?? null,
    getRevision: (id) => revisions.value.find((r) => r.id === id) ?? null,
    createProcedure: () => notImplemented('procedures.createProcedure'),
    createRevision: () => notImplemented('procedures.createRevision'),
    saveDraft: () => notImplemented('procedures.saveDraft'),
    submit: () => notImplemented('procedures.submit'),
    approve: () => notImplemented('procedures.approve'),
    reject: () => notImplemented('procedures.reject'),
    approvalsOf: () => notImplemented('procedures.approvalsOf'),
  }
})
