# stores/

Not Pinia. This directory holds non-reactive domain helpers used by the
Tasks UI:

- `jobs-store.ts` — revision-aware job merge helpers
- `entity-store.ts` — pure entity map utilities
- `ui-actions.ts` — available-action labels / filters (i18n via `vue-i18n`)

Reactive task list/detail state lives in
`composables/useControlPlaneJobsStore.ts`.
