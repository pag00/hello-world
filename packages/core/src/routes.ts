import type { RouteRecordRaw } from 'vue-router'

/**
 * All StepTrack routes, nested under one parent so a host can mount them at any path.
 * Route names are prefixed "st-" and are the public navigation API (use names, never paths).
 * Owner per view is noted for parallel development.
 */
export function createStepTrackRoutes(basePath = '/'): RouteRecordRaw[] {
  const path = basePath === '' ? '/' : basePath
  return [
    {
      path,
      component: () => import('./components/StShell.vue'),
      children: [
        // execution (tablet)
        { path: '', name: 'st-home', component: () => import('./views/HomeView.vue') },
        { path: 'runs', name: 'st-runs', component: () => import('./views/RunListView.vue') },
        { path: 'runs/new', name: 'st-run-new', component: () => import('./views/RunStartView.vue') },
        { path: 'runs/:runId', name: 'st-run', component: () => import('./views/RunView.vue'), props: true },
        { path: 'runs/:runId/steps/:stepId', name: 'st-run-step', component: () => import('./views/RunStepView.vue'), props: true },
        { path: 'q/:kind/:rest(.*)*', name: 'st-qr', component: () => import('./views/QrResolveView.vue') },
        // records & quality
        { path: 'runs/:runId/record', name: 'st-run-record', component: () => import('./views/RunRecordView.vue'), props: true },
        { path: 'runs/:runId/traveller', name: 'st-run-traveller', component: () => import('./views/TravellerView.vue'), props: true },
        { path: 'ncrs', name: 'st-ncrs', component: () => import('./views/NcrListView.vue') },
        { path: 'ncrs/:ncrId', name: 'st-ncr', component: () => import('./views/NcrView.vue'), props: true },
        // authoring
        { path: 'procedures', name: 'st-procedures', component: () => import('./views/ProcedureListView.vue') },
        { path: 'procedures/:procedureId', name: 'st-procedure', component: () => import('./views/ProcedureView.vue'), props: true },
        { path: 'revisions/:revisionId/edit', name: 'st-revision-edit', component: () => import('./views/RevisionEditView.vue'), props: true },
        // admin
        { path: 'admin/tools', name: 'st-tools', component: () => import('./views/ToolsView.vue') },
        { path: 'admin/workstations', name: 'st-workstations', component: () => import('./views/WorkstationsView.vue') },
        // session
        { path: 'login', name: 'st-login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
        { path: 'auth/callback', name: 'st-auth-callback', component: () => import('./views/AuthCallbackView.vue'), meta: { public: true } },
        { path: 'settings', name: 'st-settings', component: () => import('./views/SettingsView.vue') },
      ],
    },
  ]
}
