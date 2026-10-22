import { describe, expect, it } from 'vitest'
import { resolveWorkstationStep } from '../../src/domain/workstation'
import { projectRun } from '../../src/domain/projection'
import type { RunEvent } from '../../src/domain/types'
import { CONTENT, IDS } from '../helpers'

const RUN = 'r'
let n = 0
const ev = (type: string, step: string | null, payload: object = {}): RunEvent => ({
  id: `e${++n}`, run_id: RUN, type: type as never, step_id: step, payload: payload as never, actor_id: 'u', auth_method: 'oidc',
  device_id: 'd', client_ts: '2026-10-22T10:00:00.000Z', offline: false, supersedes: null, content_hash: 'sha256:', seq: n,
})

describe('workstation resolution', () => {
  it('picks the first actionable step at the workstation', () => {
    const created = ev('run.created', null)
    // WS-01 holds A and B (B depends on A); WS-02 holds C
    expect(resolveWorkstationStep(CONTENT, projectRun(RUN, CONTENT, [created]), 'ws-01')).toEqual({ step_id: IDS.A, candidates: [IDS.A, IDS.B] })
    const aDone = [created, ev('input.recorded', IDS.A, { input_id: IDS.A_CHECK, value: true, source: 'manual' }),
      ev('input.recorded', IDS.A, { input_id: IDS.A_TORQUE, value: '12.0', source: 'manual' }), ev('step.completed', IDS.A)]
    expect(resolveWorkstationStep(CONTENT, projectRun(RUN, CONTENT, aDone), 'WS-01').step_id).toBe(IDS.B)
    expect(resolveWorkstationStep(CONTENT, projectRun(RUN, CONTENT, aDone), ' WS-02 ').step_id).toBe(IDS.C)
    expect(resolveWorkstationStep(CONTENT, null, 'WS-99')).toEqual({ step_id: null, candidates: [] })
  })

  it('prefers a started step and skips steps only waiting for dependencies', () => {
    const evs = [ev('run.created', null), ev('step.started', IDS.C)]
    const p = projectRun(RUN, CONTENT, evs)
    expect(resolveWorkstationStep(CONTENT, p, 'WS-02').step_id).toBe(IDS.C)
    const onlyB = { ...CONTENT, sections: [{ ...CONTENT.sections[0]!, steps: [CONTENT.sections[0]!.steps[1]!] }] }
    expect(resolveWorkstationStep(onlyB, projectRun(RUN, CONTENT, evs), 'WS-01').step_id).toBeNull()
  })
})
