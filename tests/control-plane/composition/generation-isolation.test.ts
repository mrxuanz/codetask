import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getControlPlaneRuntime
} from '../../../src/server/application/control-plane-runtime'
import { bootstrapRuntime, ensureRuntimeReady, resetAppContextForTests } from '../../../src/server/bootstrap'
import { setCutoverMarkerForTests } from '../../../src/server/application/cutover-state'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function bootWithGeneration(generation: 'preparing' | 'copied' | 'v3_authoritative') {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-generation-'))
  await resetAppContextForTests()
  setCutoverMarkerForTests(generation)
  const ctx = bootstrapRuntime({ dataDir })
  await ensureRuntimeReady(ctx)
  const runtime = getControlPlaneRuntime(ctx)
  return { ctx, runtime, dataDir }
}

describe('composition: generation isolation', () => {
  it('preparing starts only legacy-side bootstrap paths (V3 scheduler idle)', async () => {
    const { runtime, dataDir } = await bootWithGeneration('preparing')
    try {
      assert.equal(runtime.schemaGeneration, 'preparing')
      assert.equal(runtime.started, false, 'V3 scheduler must stay idle before authoritative cutover')
      assert.equal(runtime.scheduler.isRunning(), false)
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('copied keeps V3 scheduler idle while legacy remains active', async () => {
    const { runtime, dataDir } = await bootWithGeneration('copied')
    try {
      assert.equal(runtime.schemaGeneration, 'copied')
      assert.equal(runtime.started, false)
      assert.equal(runtime.scheduler.isRunning(), false)
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('authoritative starts only V3 scheduler', async () => {
    const { runtime, dataDir } = await bootWithGeneration('v3_authoritative')
    try {
      assert.equal(runtime.schemaGeneration, 'v3_authoritative')
      assert.equal(runtime.started, true, 'authoritative must start V3 scheduler')
      assert.equal(runtime.scheduler.isRunning(), true)
    } finally {
      await runtime.scheduler.stop()
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
