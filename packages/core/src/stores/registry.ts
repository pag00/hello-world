import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RegistryStore } from './contracts'
import type { Ncr, Tool, User, Workstation } from '../domain/types'
import { OfflineError } from '../api/client'
import { api } from '../api/endpoints'
import { getDb, syncState } from '../sync/runtime'

export interface RegistryStoreImpl extends RegistryStore {
  hydrate(): Promise<void>
  reloadNcrs(): Promise<void>
}

/** Calendar date on the device in its local time zone — calibration is due "on a day", not an instant. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function checkToolIn(tools: readonly Tool[], code: string, on: Date = new Date()): ReturnType<RegistryStore['checkTool']> {
  const c = code.trim()
  const tool = tools.find((t) => t.code === c) ?? tools.find((t) => t.code.toLowerCase() === c.toLowerCase()) ?? null
  if (!tool) return { status: 'unknown', tool: null }
  if (!tool.active) return { status: 'inactive', tool }
  // the due date itself is still valid; expired from the following day
  if (tool.calibration_due && tool.calibration_due < localDate(on)) return { status: 'expired', tool }
  return { status: 'ok', tool }
}

export const useRegistryStore = defineStore('st-registry', (): RegistryStoreImpl => {
  const tools = ref<Tool[]>([])
  const workstations = ref<Workstation[]>([])
  const users = ref<User[]>([])
  const ncrs = ref<Ncr[]>([])

  async function hydrate() {
    const db = getDb()
    const [t, w, u, n] = await Promise.all([db.tools.toArray(), db.workstations.toArray(), db.users.toArray(), db.ncrs.toArray()])
    tools.value = t.sort((a, b) => a.code.localeCompare(b.code))
    workstations.value = w.sort((a, b) => a.code.localeCompare(b.code))
    users.value = u.sort((a, b) => a.name.localeCompare(b.name))
    ncrs.value = n.sort((a, b) => (a.raised_at < b.raised_at ? 1 : -1))
  }

  async function reloadNcrs() {
    ncrs.value = (await getDb().ncrs.toArray()).sort((a, b) => (a.raised_at < b.raised_at ? 1 : -1))
  }

  function requireOnline() {
    if (!syncState.online.value) throw new OfflineError()
  }

  return {
    tools, workstations, users, ncrs, hydrate, reloadNcrs,
    userName: (id) => (id ? (users.value.find((u) => u.id === id)?.name ?? '—') : '—'),
    checkTool: (code, on) => checkToolIn(tools.value, code, on),
    async upsertTool(tool) {
      requireOnline()
      const saved = tool.id ? await api.updateTool(tool as Tool) : await api.createTool(tool)
      await getDb().tools.put(saved)
      tools.value = [...tools.value.filter((t) => t.id !== saved.id), saved].sort((a, b) => a.code.localeCompare(b.code))
      return saved
    },
    async upsertWorkstation(ws) {
      requireOnline()
      const saved = await api.upsertWorkstation(ws)
      await getDb().workstations.put(saved)
      workstations.value = [...workstations.value.filter((w) => w.code !== saved.code), saved].sort((a, b) => a.code.localeCompare(b.code))
      return saved
    },
  }
})
