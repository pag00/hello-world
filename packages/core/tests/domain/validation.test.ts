import { describe, expect, it } from 'vitest'
import { V, matchesExpect, validateEvent, validateRunCreation, type ValidationContext } from '../../src/domain/validation'
import type { EventType, RevisionContent, RunEvent, RunEventContent, User } from '../../src/domain/types'
import { CONTENT, IDS, USERS } from '../helpers'

const RUN = 'run-1'
const PHOTO = 'sha256:' + 'ab'.repeat(32)

function content(mut?: (c: RevisionContent) => void): RevisionContent {
  const c = structuredClone(CONTENT)
  mut?.(c)
  return c
}

let n = 0
function ev<T extends EventType>(type: T, step: string | null, payload: object, actor: User = USERS.op!, extra: Partial<RunEvent> = {}): RunEvent {
  n++
  return {
    id: `e${String(n).padStart(4, '0')}`, run_id: RUN, type, step_id: step, payload: payload as never, actor_id: actor.id,
    auth_method: 'oidc', device_id: 'd1', client_ts: `2026-10-22T10:00:${String(n % 60).padStart(2, '0')}.000Z`,
    offline: false, supersedes: null, content_hash: 'sha256:x', seq: n, flags: [], ...extra,
  }
}

const created = () => ev('run.created', null, { procedure_id: 'p', revision_id: 'r', serial: 'SN', work_order: null })
const input = (step: string, inputId: string, value: unknown, actor?: User, extra?: Partial<RunEvent>) =>
  ev('input.recorded', step, { input_id: inputId, value, source: 'manual' }, actor, extra)
const aDone = (torque = '12.0') => [input(IDS.A, IDS.A_CHECK, true), input(IDS.A, IDS.A_TORQUE, torque), ev('step.completed', IDS.A, {})]

function check(events: RunEvent[], candidate: Partial<RunEventContent> & { type: EventType }, opts: Partial<ValidationContext> = {}) {
  const c: RunEventContent = {
    id: 'new', run_id: RUN, step_id: null, payload: {} as never, actor_id: (opts.actor ?? USERS.op!).id, auth_method: 'oidc',
    device_id: 'd1', client_ts: '2026-10-22T11:00:00.000Z', offline: false, supersedes: null, ...candidate,
  } as RunEventContent
  return validateEvent({ content: opts.content ?? CONTENT, events, actor: USERS.op!, online: true, ...opts }, c)
}

describe('validation on write (§4)', () => {
  it('step.completed requires all required inputs', () => {
    expect(check([created(), input(IDS.A, IDS.A_CHECK, true)], { type: 'step.completed', step_id: IDS.A })).toEqual([V + 'missingRequired'])
    expect(check([created(), ...aDone().slice(0, 2)], { type: 'step.completed', step_id: IDS.A })).toEqual([])
  })

  it('photo needs min_count refs', () => {
    const c = content((x) => { (x.sections[0]!.steps[1]!.inputs[0] as { min_count: number }).min_count = 2 })
    const evs = [created(), ...aDone(), input(IDS.B, IDS.B_PHOTO, [PHOTO]), input(IDS.B, IDS.B_TOOL, 'TW-1')]
    expect(check(evs, { type: 'step.completed', step_id: IDS.B }, { content: c })).toEqual([V + 'missingPhotos'])
    expect(check(evs, { type: 'step.completed', step_id: IDS.B })).toEqual([])
  })

  it('depends_on does not block completion validation but out-of-tolerance does until an NCR covers it', () => {
    const evs = [created(), input(IDS.B, IDS.B_PHOTO, [PHOTO]), input(IDS.B, IDS.B_TOOL, 'TW-1')]
    expect(check(evs, { type: 'step.completed', step_id: IDS.B })).toEqual([])
    const oot = [created(), input(IDS.A, IDS.A_CHECK, true), input(IDS.A, IDS.A_TORQUE, '13.0')]
    expect(check(oot, { type: 'step.completed', step_id: IDS.A })).toEqual([V + 'outOfToleranceNeedsNcr'])
    const withNcr = [...oot, ev('ncr.raised', IDS.A, { ncr_id: '0190f000-0000-7000-8000-000000000001', description: 'x', input_id: IDS.A_TORQUE })]
    expect(check(withNcr, { type: 'step.completed', step_id: IDS.A })).toEqual([])
  })

  it('tool flags need an NCR; conflict blocks completion', () => {
    const base = [created(), ...aDone(), input(IDS.B, IDS.B_PHOTO, [PHOTO])]
    expect(check([...base, input(IDS.B, IDS.B_TOOL, 'TW-1', undefined, { flags: ['tool_expired'] })], { type: 'step.completed', step_id: IDS.B }))
      .toEqual([V + 'toolNeedsNcr'])
    expect(check([...base, input(IDS.B, IDS.B_TOOL, 'TW-1', undefined, { flags: ['conflict'] })], { type: 'step.completed', step_id: IDS.B }))
      .toEqual([V + 'stepInConflict'])
  })

  it('no double completion', () => {
    expect(check([created(), ...aDone()], { type: 'step.completed', step_id: IDS.A })).toEqual([V + 'alreadyCompleted'])
  })

  it('step.verified: completed, verifier role, not the completer', () => {
    const evs = [created(), ...aDone(), input(IDS.B, IDS.B_PHOTO, [PHOTO]), input(IDS.B, IDS.B_TOOL, 'TW-1'), ev('step.completed', IDS.B, {}, USERS.insp)]
    expect(check(evs, { type: 'step.verified', step_id: IDS.B, actor_id: USERS.insp!.id }, { actor: USERS.insp })).toEqual([V + 'verifierIsCompleter'])
    expect(check(evs, { type: 'step.verified', step_id: IDS.B }, { actor: USERS.op })).toEqual([V + 'verifierRole'])
    const byOp = [...evs.slice(0, -1), ev('step.completed', IDS.B, {}, USERS.op)]
    expect(check(byOp, { type: 'step.verified', step_id: IDS.B }, { actor: USERS.insp })).toEqual([])
    expect(check([created()], { type: 'step.verified', step_id: IDS.B }, { actor: USERS.insp })).toEqual([V + 'notCompleted'])
  })

  it('scan must match expect (exact or /regex/), signoff role must be held', () => {
    expect(matchesExpect('PN-123-7', '/^PN-123-\\d+$/')).toBe(true)
    expect(matchesExpect('PN-124-7', '/^PN-123-\\d+$/')).toBe(false)
    expect(matchesExpect('abc', 'abc')).toBe(true)
    expect(matchesExpect('abcd', 'abc')).toBe(false)
    expect(matchesExpect('x', '/(/')).toBe(false)
    const c = content((x) => {
      ;(x.sections[0]!.steps[1]!.inputs[1] as { expect: string }).expect = '/^TW-\\d{3}$/'
      ;(x.sections[1]!.steps[0]!.inputs[0] as { role: string }).role = 'inspector'
    })
    const evs = [created(), ...aDone()]
    expect(check(evs, { type: 'input.recorded', step_id: IDS.B, payload: { input_id: IDS.B_TOOL, value: 'XX-1', source: 'scan' } as never }, { content: c }))
      .toEqual([V + 'scanMismatch'])
    expect(check(evs, { type: 'input.recorded', step_id: IDS.C, payload: { input_id: IDS.C_SIGN, value: true, source: 'manual' } as never }, { content: c }))
      .toEqual([V + 'signoffRole'])
    expect(check(evs, { type: 'input.recorded', step_id: IDS.C, payload: { input_id: IDS.C_SIGN, value: true, source: 'manual' } as never }, { content: c, actor: USERS.insp }))
      .toEqual([])
  })

  it('tool calibration blocks online, is allowed offline', () => {
    const evs = [created(), ...aDone()]
    const payload = { input_id: IDS.B_TOOL, value: 'TW-017', source: 'scan' } as never
    const checkTool = () => ({ status: 'expired' as const })
    expect(check(evs, { type: 'input.recorded', step_id: IDS.B, payload }, { checkTool, online: true })).toEqual([V + 'toolExpired'])
    expect(check(evs, { type: 'input.recorded', step_id: IDS.B, payload }, { checkTool, online: false })).toEqual([])
    expect(check(evs, { type: 'input.recorded', step_id: IDS.B, payload }, { checkTool: () => ({ status: 'unknown' }) })).toEqual([V + 'toolUnknown'])
  })

  it('number values must carry exactly the declared decimals', () => {
    const evs = [created()]
    const rec = (value: unknown) => check(evs, { type: 'input.recorded', step_id: IDS.A, payload: { input_id: IDS.A_TORQUE, value, source: 'manual' } as never })
    expect(rec('12.0')).toEqual([])
    expect(rec('12')).toEqual([V + 'invalidNumber'])
    expect(rec(12)).toEqual([V + 'invalidNumber'])
    expect(rec('12.00')).toEqual([V + 'invalidNumber'])
  })

  it('role rules', () => {
    const evs = [created(), ...aDone()]
    expect(check(evs, { type: 'step.reopened', step_id: IDS.A, payload: { reason: 'x' } as never })).toEqual([V + 'roleSupervisor'])
    expect(check(evs, { type: 'step.reopened', step_id: IDS.A, payload: { reason: 'x' } as never }, { actor: USERS.sup })).toEqual([])
    expect(check(evs, { type: 'step.started', step_id: IDS.C }, { actor: USERS.author })).toEqual([V + 'roleOperator'])
    expect(check(evs, { type: 'step.started', step_id: IDS.C }, { actor: USERS.insp })).toEqual([])
    expect(check(evs, { type: 'run.aborted', payload: { reason: 'scrap' } as never }, { actor: USERS.op })).toEqual([V + 'roleSupervisor'])
  })

  it('run.completed requires can_complete and inspector/supervisor', () => {
    const full = [created(), ...aDone(), input(IDS.B, IDS.B_PHOTO, [PHOTO]), input(IDS.B, IDS.B_TOOL, 'TW-1'), ev('step.completed', IDS.B, {}),
      ev('step.verified', IDS.B, {}, USERS.insp), input(IDS.C, IDS.C_SIGN, true), ev('step.completed', IDS.C, {})]
    expect(check(full, { type: 'run.completed' }, { actor: USERS.op })).toEqual([V + 'roleCompleteRun'])
    expect(check(full, { type: 'run.completed' }, { actor: USERS.insp })).toEqual([])
    expect(check(full.slice(0, -1), { type: 'run.completed' }, { actor: USERS.sup })).toEqual([V + 'runCannotComplete'])
  })

  it('events on a closed run are rejected', () => {
    const evs = [created(), ev('run.aborted', null, { reason: 'x' }, USERS.sup)]
    expect(check(evs, { type: 'note.added', payload: { text: 'hi' } as never })).toEqual([V + 'runClosed'])
  })

  it('NCR lifecycle', () => {
    const ncrId = '0190f000-0000-7000-8000-000000000777'
    const raised = [created(), ev('ncr.raised', IDS.A, { ncr_id: ncrId, description: 'dent' })]
    expect(check(raised, { type: 'ncr.closed', step_id: IDS.A, payload: { ncr_id: ncrId } as never }, { actor: USERS.sup })).toEqual([V + 'ncrNotDispositioned'])
    expect(check(raised, { type: 'ncr.dispositioned', step_id: IDS.A, payload: { ncr_id: ncrId, disposition: 'rework', note: 'redo' } as never }, { actor: USERS.sup })).toEqual([])
    expect(check(raised, { type: 'ncr.dispositioned', step_id: IDS.A, payload: { ncr_id: ncrId, disposition: 'bogus', note: '' } as never }, { actor: USERS.sup }))
      .toEqual([V + 'dispositionRequired', V + 'noteRequired'])
    expect(check(raised, { type: 'ncr.raised', step_id: IDS.A, payload: { ncr_id: ncrId, description: 'again' } as never })).toEqual([V + 'ncrExists'])
  })

  it('supersedes must target a live event of the same input', () => {
    const t = input(IDS.A, IDS.A_TORQUE, '99.0')
    const evs = [created(), t, input(IDS.A, IDS.A_CHECK, true)]
    const rec = (supersedes: string, inputId = IDS.A_TORQUE) =>
      check(evs, { type: 'input.recorded', step_id: IDS.A, supersedes, payload: { input_id: inputId, value: inputId === IDS.A_CHECK ? true : '12.0', source: 'manual' } as never })
    expect(rec(t.id)).toEqual([])
    expect(rec('nope')).toEqual([V + 'unknownSupersedes'])
    expect(rec(t.id, IDS.A_CHECK)).toEqual([V + 'supersedesMismatch'])
  })

  it('run creation', () => {
    expect(validateRunCreation({ actor: USERS.op!, revisionStatus: 'released', serial: 'SN-1' })).toEqual([])
    expect(validateRunCreation({ actor: USERS.op!, revisionStatus: 'draft', serial: ' ' })).toEqual([V + 'revisionNotReleased', V + 'serialRequired'])
    expect(validateRunCreation({ actor: USERS.author!, revisionStatus: null, serial: 'x' })).toEqual([V + 'roleOperator', V + 'unknownRevision'])
  })
})
