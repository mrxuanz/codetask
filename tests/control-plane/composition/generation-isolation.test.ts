import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ensureControlPlaneRuntime,
  getControlPlaneRuntime,
  type ControlPlaneRuntime
} from '../../../src/server/application/control-plane-runtime'
import { createV3ApplicationRuntimeForTests } from '../../../src/server/application/application-runtime'
import { bootstrapRuntime, ensureRuntimeReady, resetAppContextForTests } from '../../../src/server/bootstrap'
import { setCutoverMarkerForTests } from '../../../src/server/application/cutover-state'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppContext } from '../../../src/server/context'

async function bootLegacyWithGeneration(
  generation: 'preparing' | 'copied'
): Promise<{ ctx: AppContext; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-generation-'))
  await resetAppContextForTests()
  setCutoverMarkerForTests(generation)
  const ctx = bootstrapRuntime({ dataDir })
  await ensureRuntimeReady(ctx)
  return { ctx, dataDir }
}

async function bootV3ForTests(): Promise<{
  ctx: AppContext
  runtime: ControlPlaneRuntime
  dataDir: string
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-generation-v3-'))
  await resetAppContextForTests()
  setCutoverMarkerForTests('copied')
  const ctx = bootstrapRuntime({ dataDir })
  setCutoverMarkerForTests('v3_authoritative')
  ctx.applicationRuntime = createV3ApplicationRuntimeForTests(ctx)
  await ensureRuntimeReady(ctx)
  const runtime = getControlPlaneRuntime(ctx)
  return { ctx, runtime, dataDir }
}

describe('composition: generation isolation', () => {
  it('preparing starts only Legacy root with no V3 control plane', async () => {
    const { ctx, dataDir } = await bootLegacyWithGeneration('preparing')
    try {
      assert.equal(ctx.applicationRuntime?.kind, 'legacy')
      assert.equal(ensureControlPlaneRuntime(ctx), null)
      assert.equal(ctx.applicationRuntime?.started, true)
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('copied starts only Legacy root with no V3 control plane', async () => {
    const { ctx, dataDir } = await bootLegacyWithGeneration('copied')
    try {
      assert.equal(ctx.applicationRuntime?.kind, 'legacy')
      assert.equal(ensureControlPlaneRuntime(ctx), null)
      assert.equal(ctx.applicationRuntime?.started, true)
    } finally {
      await resetAppContextForTests()
      setCutoverMarkerForTests(null)
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('authoritative V3 test factory starts only V3 scheduler', async () => {
    const { runtime, dataDir } = await bootV3ForTests()
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
