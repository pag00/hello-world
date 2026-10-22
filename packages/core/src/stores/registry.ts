import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RegistryStore } from './contracts'
import type { Ncr, Tool, User, Workstation } from '../domain/types'
import { notImplemented } from './_stub'

export const useRegistryStore = defineStore('st-registry', (): RegistryStore => {
  const users = ref<User[]>([])
  return {
    tools: ref<Tool[]>([]),
    workstations: ref<Workstation[]>([]),
    users,
    ncrs: ref<Ncr[]>([]),
    userName: (id) => users.value.find((u) => u.id === id)?.name ?? '—',
    checkTool: () => ({ status: 'unknown', tool: null }),
    upsertTool: () => notImplemented('registry.upsertTool'),
    upsertWorkstation: () => notImplemented('registry.upsertWorkstation'),
  }
})
