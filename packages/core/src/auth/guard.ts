import type { Router } from 'vue-router'
import type { Pinia } from 'pinia'
import { useSessionStore } from '../stores/session'

/**
 * Redirect StepTrack routes (names "st-*") to st-login while nobody is signed in.
 * Host routes are left alone; routes with meta.public are always reachable.
 */
export function installAuthGuard(router: Router, pinia?: Pinia): () => void {
  return router.beforeEach(async (to) => {
    if (typeof to.name !== 'string' || !to.name.startsWith('st-')) return true
    if (to.meta.public) return true
    const session = useSessionStore(pinia)
    await session.ready()
    if (session.user) return true
    return { name: 'st-login', query: { redirect: to.fullPath } }
  })
}
