import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectRun } from '../../../domain/projection'
import { parseQr } from '../../../domain/qr'
import type { EventPayloads, EventType, RevisionContent, Run, RunEvent, RunProjection } from '../../../domain/types'
import { resolveQr, type QrContext } from '../qrRouting'
import { flattenSteps, isStepDone, nextStepId, pendingDependencies, progressOf } from '../runNav'

const CONTENT: RevisionContent = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../spec/test-vectors/projection/01_empty.json'), 'utf8'),
).revision_content
const A = '00000000-0000-7000-8000-000000000008' // WS-01, check + torque
const B = '00000000-0000-7000-8000-000000000009' // WS-01, depends on A, verification required
const C = '00000000-0000-7000-8000-00000000000a' // WS-02
const OTHER: RevisionContent = { schema: 1, sections: [{ id: 's', title: 'x', steps: [{ ...CONTENT.sections[1]!.steps[0]!, id: 'd0000000-0000-7000-8000-000000000001', locations: ['WS-09'] }] }] }

let n = 0
function ev<T extends EventType>(runId: string, type: T, stepId: string | null, payload: EventPayloads[T] = {} as EventPayloads[T]): RunEvent {
  n++
  return {
    id: `e${String(n).padStart(4, '0')}`, run_id: runId, type, step_id: stepId, payload, actor_id: 'u', auth_method: 'oidc',
    device_id: 'd', client_ts: `2026-10-22T10:00:${String(n % 60).padStart(2, '0')}.000Z`, offline: false, supersedes: null,
    content_hash: 'sha256:x', seq: n,
  } as RunEvent
}

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id, procedure_id: 'p', revision_id: over.revision_id ?? 'rev', serial: `SN-${id}`, work_order: null, status: 'active',
    created_by: 'u', created_at: `2026-10-0${id.length % 9}T00:00:00.000Z`, closed_at: null, ...over,
  }
}

function ctx(runs: Run[], opts: { active?: string | null; device?: string[]; events?: Record<string, RunEvent[]> } = {}): QrContext {
  const projections = new Map<string, RunProjection>()
  for (const r of runs) projections.set(r.id, projectRun(r.id, r.revision_id === 'other' ? OTHER : CONTENT, opts.events?.[r.id] ?? []))
  return {
    runs,
    activeRunId: opts.active ?? null,
    deviceRunIds: new Set(opts.device ?? []),
    contentOf: (r) => (r.revision_id === 'other' ? OTHER : r.revision_id === 'missing' ? null : CONTENT),
    projectionOf: (r) => projections.get(r.id) ?? null,
  }
}

const completeA = (runId: string) => [
  ev(runId, 'input.recorded', A, { input_id: '00000000-0000-7000-8000-00000000000b', value: true, source: 'manual' }),
  ev(runId, 'input.recorded', A, { input_id: '00000000-0000-7000-8000-00000000000c', value: '12.0', source: 'manual' }),
  ev(runId, 'step.completed', A),
]

describe('resolveQr: workstation', () => {
  it('active run: first actionable step at the workstation', () => {
    const r1 = run('r1')
    expect(resolveQr(parseQr('st:ws:WS-01'), ctx([r1], { active: 'r1' }))).toEqual({
      type: 'navigate', to: { name: 'st-run-step', params: { runId: 'r1', stepId: A } },
    })
    expect(resolveQr(parseQr('https://host/app/q/ws/ws-02'), ctx([r1], { active: 'r1' }))).toEqual({
      type: 'navigate', to: { name: 'st-run-step', params: { runId: 'r1', stepId: C } },
    })
  })

  it('skips completed steps and steps only waiting for dependencies', () => {
    const r1 = run('r1')
    // A done → B (deps met) is next at WS-01
    expect(resolveQr(parseQr('st:ws:WS-01'), ctx([r1], { active: 'r1', events: { r1: completeA('r1') } }))).toMatchObject({
      to: { params: { stepId: B } },
    })
  })

  it('nothing actionable in the active run → list of its steps there', () => {
    const r1 = run('r1')
    const evs = [...completeA('r1'), ev('r1', 'input.recorded', C, { input_id: '00000000-0000-7000-8000-00000000000f', value: true, source: 'manual' }), ev('r1', 'step.completed', C)]
    expect(resolveQr(parseQr('st:ws:WS-02'), ctx([r1], { active: 'r1', events: { r1: evs } }))).toEqual({
      type: 'choose-step', run: r1, code: 'WS-02', stepIds: [C],
    })
  })

  it('no active run: the single open run with that workstation is used', () => {
    const r1 = run('r1')
    const r2 = run('r2', { revision_id: 'other' })
    expect(resolveQr(parseQr('st:ws:WS-09'), ctx([r1, r2]))).toMatchObject({ type: 'navigate', to: { params: { runId: 'r2' } } })
  })

  it('active run without that workstation → asks before switching, even for one candidate', () => {
    const r1 = run('r1')
    const r2 = run('r2', { revision_id: 'other' })
    const res = resolveQr(parseQr('st:ws:WS-09'), ctx([r1, r2], { active: 'r1' }))
    expect(res).toMatchObject({ type: 'choose-run', reason: 'workstation', code: 'WS-09' })
    expect(res.type === 'choose-run' && res.runs.map((r) => r.id)).toEqual(['r2'])
  })

  it('several candidates → choose, runs checked out to this device first', () => {
    const r1 = run('r1')
    const r2 = run('r22')
    const res = resolveQr(parseQr('st:ws:WS-01'), ctx([r1, r2], { device: ['r1'] }))
    expect(res.type).toBe('choose-run')
    expect(res.type === 'choose-run' && res.runs.map((r) => r.id)).toEqual(['r1', 'r22'])
  })

  it('closed runs and unknown workstations are not candidates', () => {
    const r1 = run('r1', { status: 'completed' })
    expect(resolveQr(parseQr('st:ws:WS-01'), ctx([r1], { active: 'r1' }))).toEqual({ type: 'workstation-none', code: 'WS-01' })
    expect(resolveQr(parseQr('st:ws:WS-77'), ctx([run('r2')]))).toEqual({ type: 'workstation-none', code: 'WS-77' })
  })

  it('blocked runs (e.g. out of tolerance) still resolve', () => {
    const r1 = run('r1', { status: 'blocked' })
    expect(resolveQr(parseQr('st:ws:WS-01'), ctx([r1], { active: 'r1' }))).toMatchObject({ type: 'navigate' })
  })
})

describe('resolveQr: other targets', () => {
  it('run label → run page, even if unknown on this device', () => {
    const id = '0190f000-0000-7000-8000-0000000000ff'
    expect(resolveQr(parseQr(`st:run:${id}`), ctx([]))).toEqual({ type: 'navigate', to: { name: 'st-run', params: { runId: id } } })
  })

  it('part label → run of that serial; several → choose; none → offer start', () => {
    const r1 = run('r1', { serial: 'SN-100' })
    const r2 = run('r2', { serial: 'SN-200', status: 'completed' })
    const r3 = run('r3', { serial: 'SN-200' })
    const c = ctx([r1, r2, r3])
    expect(resolveQr(parseQr('st:part:PN-1:sn-100'), c)).toEqual({ type: 'navigate', to: { name: 'st-run', params: { runId: 'r1' } } })
    // one open + one closed run of the same serial: the open one
    expect(resolveQr(parseQr('st:part:PN-1:SN-200'), c)).toMatchObject({ to: { params: { runId: 'r3' } } })
    const r4 = run('r4', { serial: 'SN-200' })
    expect(resolveQr(parseQr('st:part:PN-1:SN-200'), ctx([r2, r3, r4]))).toMatchObject({ type: 'choose-run', reason: 'part' })
    expect(resolveQr(parseQr('st:part:PN-1:SN-999'), c)).toEqual({ type: 'part-none', part_number: 'PN-1', serial: 'SN-999' })
    // only a closed run → still shows it
    expect(resolveQr(parseQr('st:part:PN-1:SN-200'), ctx([r2]))).toMatchObject({ to: { params: { runId: 'r2' } } })
  })

  it('tool and unknown labels', () => {
    expect(resolveQr(parseQr('st:tool:TW-017'), ctx([]))).toEqual({ type: 'tool', code: 'TW-017' })
    expect(resolveQr(parseQr('hello'), ctx([]))).toEqual({ type: 'unknown', raw: 'hello' })
  })
})

describe('runNav', () => {
  it('numbers steps by section and position', () => {
    expect(flattenSteps(CONTENT).map((s) => s.number)).toEqual(['1.1', '1.2', '2.1'])
    expect(flattenSteps(null)).toEqual([])
  })

  it('next step: first open step, started ones first, dependency waits skipped', () => {
    const p0 = projectRun('r', CONTENT, [])
    expect(nextStepId(CONTENT, p0)).toBe(A)
    const startedC = [ev('r', 'step.started', C)]
    expect(nextStepId(CONTENT, projectRun('r', CONTENT, startedC))).toBe(C)
    const p1 = projectRun('r', CONTENT, completeA('r'))
    expect(nextStepId(CONTENT, p1)).toBe(B)
    expect(pendingDependencies(CONTENT.sections[0]!.steps[1]!, p0, flattenSteps(CONTENT)).map((r) => r.number)).toEqual(['1.1'])
    expect(pendingDependencies(CONTENT.sections[0]!.steps[1]!, p1, flattenSteps(CONTENT))).toEqual([])
  })

  it('a completed step that needs verification is not done', () => {
    const evs = [
      ...completeA('r'),
      ev('r', 'input.recorded', B, { input_id: '00000000-0000-7000-8000-00000000000d', value: ['sha256:' + 'a'.repeat(64)], source: 'manual' }),
      ev('r', 'input.recorded', B, { input_id: '00000000-0000-7000-8000-00000000000e', value: 'TW-1', source: 'scan' }),
      ev('r', 'step.completed', B),
    ]
    const p = projectRun('r', CONTENT, evs)
    const stepB = CONTENT.sections[0]!.steps[1]!
    expect(p.steps[B]!.state).toBe('completed')
    expect(isStepDone(stepB, p.steps[B])).toBe(false)
    expect(nextStepId(CONTENT, p)).toBe(B)
    expect(progressOf(CONTENT, p)).toEqual({ done: 1, total: 3 })
  })
})
