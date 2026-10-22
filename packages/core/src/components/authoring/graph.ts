// Step dependency graph (depends_on). A cycle would make every step in it permanently blocked on the
// shop floor, so the editor refuses to create one and validation reports any that slip in.
import type { RevisionContent, Step, Uuid } from '../../domain/types'

export function stepsOf(content: RevisionContent): Step[] {
  return content.sections.flatMap((s) => s.steps)
}

function edges(steps: readonly Step[]): Map<Uuid, Uuid[]> {
  const known = new Set(steps.map((s) => s.id))
  // unknown targets are reported separately (validation); they cannot be part of a cycle
  return new Map(steps.map((s) => [s.id, s.depends_on.filter((d) => known.has(d))]))
}

/** First dependency cycle found, as step ids in dependency order with the start repeated at the end; null if acyclic. */
export function findCycle(content: RevisionContent): Uuid[] | null {
  const graph = edges(stepsOf(content))
  const state = new Map<Uuid, 1 | 2>() // 1 = on stack, 2 = done
  const stack: Uuid[] = []

  // iterative DFS: procedures are small, but a recursive walk over user data is a needless stack risk
  for (const root of graph.keys()) {
    if (state.has(root)) continue
    const iters: Array<{ id: Uuid; next: number }> = [{ id: root, next: 0 }]
    state.set(root, 1)
    stack.push(root)
    while (iters.length) {
      const top = iters[iters.length - 1]!
      const deps = graph.get(top.id)!
      if (top.next < deps.length) {
        const d = deps[top.next++]!
        const s = state.get(d)
        if (s === 1) return [...stack.slice(stack.indexOf(d)), d]
        if (s === undefined) {
          state.set(d, 1)
          stack.push(d)
          iters.push({ id: d, next: 0 })
        }
      } else {
        state.set(top.id, 2)
        stack.pop()
        iters.pop()
      }
    }
  }
  return null
}

/** Every step that (transitively) depends on `stepId`. */
export function dependentsOf(content: RevisionContent, stepId: Uuid): Set<Uuid> {
  const steps = stepsOf(content)
  const reverse = new Map<Uuid, Uuid[]>()
  for (const s of steps) for (const d of s.depends_on) reverse.set(d, [...(reverse.get(d) ?? []), s.id])
  const out = new Set<Uuid>()
  const queue = [...(reverse.get(stepId) ?? [])]
  while (queue.length) {
    const id = queue.shift()!
    if (out.has(id)) continue
    out.add(id)
    queue.push(...(reverse.get(id) ?? []))
  }
  return out
}

/** Adding "stepId depends on depId" closes a cycle iff depId already (transitively) depends on stepId, or is stepId. */
export function wouldCreateCycle(content: RevisionContent, stepId: Uuid, depId: Uuid): boolean {
  return stepId === depId || dependentsOf(content, stepId).has(depId)
}

/**
 * Every step that lies on some dependency cycle of length ≥ 2 (self-dependencies are reported on their
 * own). Quadratic, which is fine for procedure-sized graphs and keeps the logic obviously right.
 */
export function cyclicSteps(content: RevisionContent): Set<Uuid> {
  const graph = edges(stepsOf(content))
  const out = new Set<Uuid>()
  for (const start of graph.keys()) {
    const seen = new Set<Uuid>()
    const queue = (graph.get(start) ?? []).filter((d) => d !== start)
    while (queue.length) {
      const id = queue.pop()!
      if (id === start) {
        out.add(start)
        break
      }
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...(graph.get(id) ?? []))
    }
  }
  return out
}
