import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orderEvents, projectRun } from '../../src/domain/projection'
import type { RevisionContent, RunEvent } from '../../src/domain/types'

interface Vector {
  name: string
  description: string
  revision_content: RevisionContent
  events: RunEvent[]
  expected: {
    status: string
    can_complete: boolean
    open_ncr_ids: string[]
    steps: Record<string, { state: string; block_reasons: string[] }>
    input_values?: Record<string, unknown>
  }
}

const dir = join(__dirname, '../../../../spec/test-vectors/projection')
const vectors: Vector[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))

const RUN = '00000000-0000-7000-8000-000000000001'

describe('projection vectors', () => {
  it('found the shared vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20)
  })

  for (const v of vectors) {
    describe(v.name, () => {
      const check = (events: RunEvent[]) => {
        const p = projectRun(RUN, v.revision_content, events)
        expect(p.status).toBe(v.expected.status)
        expect(p.can_complete).toBe(v.expected.can_complete)
        expect(p.open_ncr_ids).toEqual(v.expected.open_ncr_ids)
        for (const [stepId, exp] of Object.entries(v.expected.steps)) {
          expect({ step: stepId, state: p.steps[stepId]?.state, reasons: p.steps[stepId]?.block_reasons }).toEqual({
            step: stepId,
            state: exp.state,
            reasons: exp.block_reasons,
          })
        }
        const inputValues = new Map<string, unknown>()
        for (const s of Object.values(p.steps)) for (const i of Object.values(s.inputs)) inputValues.set(i.input_id, i.value)
        for (const [inputId, value] of Object.entries(v.expected.input_values ?? {})) {
          expect(inputValues.get(inputId)).toEqual(value)
        }
      }

      it(v.description, () => check(v.events))
      // projection must not depend on the order events arrive in
      it('is independent of input order', () => check([...v.events].reverse()))
    })
  }
})

describe('event ordering', () => {
  const base = { run_id: RUN, type: 'note.added', step_id: null, payload: { text: 'x' }, actor_id: 'a', auth_method: 'oidc', device_id: 'd', offline: true, supersedes: null, content_hash: 'sha256:' } as const
  it('orders seq first, then client_ts, then id', () => {
    const evs = [
      { ...base, id: 'c', client_ts: '2026-01-01T00:00:00.000Z', seq: null },
      { ...base, id: 'b', client_ts: '2026-01-01T00:00:00.000Z', seq: null },
      { ...base, id: 'z', client_ts: '2027-01-01T00:00:00.000Z', seq: 2 },
      { ...base, id: 'y', client_ts: '2028-01-01T00:00:00.000Z', seq: 1 },
      { ...base, id: 'a', client_ts: '2025-01-01T00:00:00.000Z' },
    ] as RunEvent[]
    expect(orderEvents(evs).map((e) => e.id)).toEqual(['y', 'z', 'a', 'b', 'c'])
  })
})
