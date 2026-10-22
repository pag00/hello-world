import { createApp } from 'vue'
import Dexie from 'dexie'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setStepTrackConfig } from '../src/config'
import type { AuthProvider, AuthUser } from '../src/auth/types'
import type {
  Procedure, ProcedureRevision, PullResponse, PushResult, RevisionContent, RunEvent, StepLock, User,
} from '../src/domain/types'
import { disposeRuntime, getDb } from '../src/sync/runtime'

export const API = 'http://api.test'

const vec = JSON.parse(readFileSync(join(__dirname, '../../../spec/test-vectors/projection/01_empty.json'), 'utf8'))
export const CONTENT: RevisionContent = vec.revision_content
export const IDS = {
  A: '00000000-0000-7000-8000-000000000008',
  B: '00000000-0000-7000-8000-000000000009',
  C: '00000000-0000-7000-8000-00000000000a',
  A_CHECK: '00000000-0000-7000-8000-00000000000b',
  A_TORQUE: '00000000-0000-7000-8000-00000000000c',
  B_PHOTO: '00000000-0000-7000-8000-00000000000d',
  B_TOOL: '00000000-0000-7000-8000-00000000000e',
  C_SIGN: '00000000-0000-7000-8000-00000000000f',
}

export const USERS: Record<string, User> = {
  op: { id: '0190f000-0000-7000-8000-0000000000a1', name: 'Olga Operator', roles: ['operator'] },
  insp: { id: '0190f000-0000-7000-8000-0000000000a2', name: 'Ingo Inspector', roles: ['inspector'] },
  sup: { id: '0190f000-0000-7000-8000-0000000000a3', name: 'Sara Supervisor', roles: ['supervisor', 'operator'] },
  author: { id: '0190f000-0000-7000-8000-0000000000a4', name: 'Anna Author', roles: ['author'] },
}

export const PROCEDURE: Procedure = { id: '0190f000-0000-7000-8000-0000000000b1', number: 'ASM-0042', title: 'Bulkhead', created_at: '2026-01-01T00:00:00.000Z' }
export const REVISION: ProcedureRevision = {
  id: '0190f000-0000-7000-8000-0000000000c1', procedure_id: PROCEDURE.id, rev: 'A', status: 'released', content: CONTENT,
  content_hash: 'sha256:' + '1'.repeat(64), change_reason: null, author_id: USERS.author!.id, created_at: '2026-01-01T00:00:00.000Z',
  submitted_at: null, released_at: '2026-01-02T00:00:00.000Z', obsoleted_at: null,
}

export class FakeAuth implements AuthProvider {
  constructor(public user: AuthUser | null) {}
  async getAccessToken() { return this.user?.id ?? null }
  async getAuthorizationHeader() { return this.user ? `Dev ${this.user.id}` : null }
  async getUser() { return this.user }
  async login() {}
  async logout() { this.user = null }
}

export interface Call { method: string; path: string; body: unknown; headers: Headers }

type Handler = (req: Call) => Response | Promise<Response> | undefined

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** In-memory stand-in for the sync server; behaviour can be overridden per test via `handlers`. */
export class FakeServer {
  online = true
  calls: Call[] = []
  handlers: Handler[] = []
  me: User | null = USERS.op!
  seq = 0
  ledger: RunEvent[] = []
  blobs = new Map<string, Uint8Array>()
  pullPages: PullResponse[] = []
  locks = new Map<string, StepLock>()
  pushResult?: (ev: RunEvent) => PushResult | undefined
  /** force checkout responses to name another device */
  checkoutDevice?: string

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!this.online) throw new TypeError('Failed to fetch')
    const url = new URL(String(input))
    const path = url.pathname + url.search
    let body: unknown = init?.body
    if (typeof body === 'string') body = JSON.parse(body)
    else if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer())
    const call: Call = { method: init?.method ?? 'GET', path, body, headers: new Headers(init?.headers) }
    this.calls.push(call)
    for (const h of this.handlers) {
      const r = await h(call)
      if (r) return r
    }
    return this.route(call)
  }

  callsTo(prefix: string, method?: string) {
    return this.calls.filter((c) => c.path.startsWith(prefix) && (!method || c.method === method))
  }

  private route(c: Call): Response {
    const p = c.path.split('?')[0]!
    if (p === '/health') return json({ ok: true })
    if (p === '/me') return this.me ? json(this.me) : json({ detail: 'unauthorized' }, 401)
    if (p === '/sync/push') {
      const { events } = c.body as { events: RunEvent[] }
      const results: PushResult[] = events.map((e) => {
        const custom = this.pushResult?.(e)
        if (custom) return custom
        const known = this.ledger.find((x) => x.id === e.id)
        if (known) return known.content_hash === e.content_hash ? { id: e.id, status: 'duplicate', seq: known.seq } : { id: e.id, status: 'rejected', error: 'hash mismatch' }
        const stored = { ...e, seq: ++this.seq, flags: [] }
        this.ledger.push(stored)
        return { id: e.id, status: 'accepted', seq: stored.seq, flags: [] }
      })
      return json({ results })
    }
    if (p === '/sync/pull') {
      const cursor = new URLSearchParams(c.path.split('?')[1]).get('cursor')
      const idx = cursor ? Number(cursor) : 0
      const page = this.pullPages[idx]
      if (!page) return json(emptyPull(String(idx)))
      return json(page)
    }
    const blob = /^\/blobs\/([0-9a-f]{64})$/.exec(p)
    if (blob) {
      if (c.method === 'HEAD') return new Response(null, { status: this.blobs.has(blob[1]!) ? 200 : 404 })
      if (c.method === 'PUT') {
        this.blobs.set(blob[1]!, c.body as Uint8Array)
        return new Response(null, { status: 204 })
      }
      const b = this.blobs.get(blob[1]!)
      return b ? new Response(b as BodyInit, { headers: { 'content-type': 'image/jpeg' } }) : new Response(null, { status: 404 })
    }
    const lock = /^\/runs\/([^/]+)\/steps\/([^/]+)\/lock$/.exec(p)
    if (lock && c.method === 'POST') {
      const l: StepLock = { lock_id: crypto.randomUUID(), run_id: lock[1]!, step_id: lock[2]!, holder_user: this.me!.id,
        holder_device: String((c.body as { device_id?: string })?.device_id ?? 'unknown'), expires_at: new Date(Date.now() + 120_000).toISOString() }
      this.locks.set(l.lock_id, l)
      return json(l)
    }
    const hb = /^\/locks\/([^/]+)\/heartbeat$/.exec(p)
    if (hb) {
      const l = this.locks.get(hb[1]!)
      if (!l) return json({ detail: 'gone' }, 404)
      l.expires_at = new Date(Date.now() + 120_000).toISOString()
      return json(l)
    }
    const del = /^\/locks\/([^/]+)$/.exec(p)
    if (del && c.method === 'DELETE') {
      this.locks.delete(del[1]!)
      return new Response(null, { status: 204 })
    }
    const co = /^\/runs\/([^/]+)\/checkout$/.exec(p)
    if (co) {
      if (c.method === 'DELETE') return new Response(null, { status: 204 })
      return json({ run_id: co[1], holder_user: this.me!.id, holder_device: this.checkoutDevice ?? (c.body as { device_id: string }).device_id, expires_at: new Date(Date.now() + 12 * 3600_000).toISOString() })
    }
    return json({ detail: `no route ${c.method} ${p}` }, 404)
  }
}

export function emptyPull(cursor: string, more: Partial<PullResponse> = {}): PullResponse {
  return { cursor, has_more: false, procedures: [], revisions: [], runs: [], events: [], tools: [], workstations: [], ncrs: [], users: [], ...more }
}

let dbCounter = 0

/** Fresh pinia + config + database per test. */
export async function setup(opts: { user?: User | null; online?: boolean; seed?: boolean } = {}) {
  disposeRuntime()
  const server = new FakeServer()
  server.online = opts.online ?? true
  globalThis.fetch = server.fetch as typeof fetch
  const user = opts.user === undefined ? USERS.op! : opts.user
  server.me = user
  const auth = new FakeAuth(user ? { id: user.id, name: user.name, roles: user.roles } : null)
  const app = createApp({})
  const pinia = createPinia()
  app.use(pinia)
  setActivePinia(pinia)
  setStepTrackConfig(app, { apiBaseUrl: API, basePath: '/', auth, dbName: `steptrack-test-${process.pid}-${++dbCounter}` })
  if (opts.seed !== false) {
    const db = getDb()
    await db.procedures.put(PROCEDURE)
    await db.revisions.put(REVISION)
    await db.users.bulkPut(Object.values(USERS))
  }
  return { server, auth, app, pinia }
}

export async function teardown() {
  const name = getDb().name
  disposeRuntime()
  await Dexie.delete(name)
}
