/**
 * Thin TS entry for composition-root boot smoke (spawned by boot-new.mjs).
 *
 * Usage (via wrapper):
 *   node scripts/cutover/boot-new.mjs
 */

import { createApplication } from '../../src/server/composition/index.ts'

function main(): void {
  const app = createApplication({ mode: 'memory' })
  try {
    if (!app.clock || !app.ids || !app.logger || !app.jobs || !app.unitOfWork) {
      throw new Error('createApplication smoke failed: missing core deps')
    }
    if (app.kind !== 'memory') {
      throw new Error(`createApplication smoke failed: expected memory kind, got ${app.kind}`)
    }
    // Touch ports so the smoke is slightly more than a no-op import.
    const now = app.clock.now()
    const id = app.ids.next()
    if (!(now instanceof Date) || typeof id !== 'string' || id.length === 0) {
      throw new Error('createApplication smoke failed: clock/ids returned unexpected values')
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          step: 'boot-new',
          message: 'createApplication smoke ok',
          kind: app.kind,
          sampleId: id,
          nowIso: now.toISOString()
        },
        null,
        2
      )
    )
  } finally {
    app.close()
  }
}

main()
