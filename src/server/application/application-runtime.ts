import type { AppContext } from '../context'
import { readSchemaGeneration, type SchemaGenerationRead } from './cutover-state'
import {
  bootstrapControlPlaneRuntime,
  createControlPlaneRuntime,
  shutdownControlPlaneRuntime,
  startControlPlaneScheduler,
  type ControlPlaneRuntime
} from './control-plane-runtime'
import type { ShutdownReason } from './shutdown-coordinator'
import type { StartupCoordinator } from './startup-coordinator'

export interface LegacyApplicationRuntime {
  readonly kind: 'legacy'
  readonly ctx: AppContext
  readonly schemaRead: SchemaGenerationRead
  readonly startup: StartupCoordinator
  readonly controlPlane: ControlPlaneRuntime | null
  started: boolean
  startPromise: Promise<void> | null
  shutdownPromise: Promise<void> | null
}

export interface V3ApplicationRuntime {
  readonly kind: 'v3'
  readonly ctx: AppContext
  readonly schemaRead: 'v3_authoritative'
  readonly controlPlane: ControlPlaneRuntime
  started: boolean
  startPromise: Promise<void> | null
  shutdownPromise: Promise<void> | null
}

export type ApplicationRuntime = V3ApplicationRuntime | LegacyApplicationRuntime

export function createV3ApplicationRuntime(ctx: AppContext): V3ApplicationRuntime {
  const controlPlane = createControlPlaneRuntime(ctx)
  if (controlPlane === null) {
    throw new Error('Control-plane schema is unavailable for v3_authoritative')
  }
  return {
    kind: 'v3',
    ctx,
    schemaRead: 'v3_authoritative',
    controlPlane,
    started: false,
    startPromise: null,
    shutdownPromise: null
  }
}

export function getApplicationRuntime(ctx: AppContext): ApplicationRuntime {
  if (!ctx.applicationRuntime) {
    throw new Error('Application runtime not bootstrapped')
  }
  return ctx.applicationRuntime
}

export function getApplicationStartup(ctx: AppContext): StartupCoordinator {
  const runtime = getApplicationRuntime(ctx)
  if (runtime.kind === 'v3') {
    return runtime.controlPlane.startup
  }
  return runtime.startup
}

async function ensureLegacyApplicationRuntime(ctx: AppContext): Promise<LegacyApplicationRuntime> {
  if (ctx.applicationRuntime?.kind === 'legacy') {
    return ctx.applicationRuntime
  }
  const { createLegacyApplicationRuntime } = await import('./legacy-application-runtime')
  const runtime = createLegacyApplicationRuntime(ctx, readSchemaGeneration(ctx.db))
  ctx.applicationRuntime = runtime
  return runtime
}

export async function startApplicationRuntime(ctx: AppContext): Promise<void> {
  if (ctx.applicationRuntime?.kind === 'v3') {
    return startV3ApplicationRuntime(ctx.applicationRuntime)
  }
  const legacyRuntime = await ensureLegacyApplicationRuntime(ctx)
  const { startLegacyApplicationRuntime } = await import('./legacy-application-runtime')
  return startLegacyApplicationRuntime(legacyRuntime)
}

async function startV3ApplicationRuntime(runtime: V3ApplicationRuntime): Promise<void> {
  if (runtime.startPromise !== null) {
    return runtime.startPromise
  }

  runtime.startPromise = startV3ApplicationRuntimeOnce(runtime).catch((error: unknown) => {
    runtime.startPromise = null
    throw error
  })

  return runtime.startPromise
}

async function startV3ApplicationRuntimeOnce(runtime: V3ApplicationRuntime): Promise<void> {
  const rollback: Array<() => Promise<void>> = []

  try {
    await bootstrapControlPlaneRuntime(runtime.ctx)
    rollback.push(async () => {
      await shutdownControlPlaneRuntime('app_shutdown', runtime.ctx)
    })

    await startControlPlaneScheduler(runtime.ctx)
    runtime.started = true
  } catch (error: unknown) {
    for (const stop of rollback.reverse()) {
      await stop().catch(() => {})
    }
    throw error
  }
}

export async function shutdownApplicationRuntime(
  ctx: AppContext,
  reason: ShutdownReason
): Promise<void> {
  const runtime = ctx.applicationRuntime
  if (!runtime) return

  if (runtime.kind === 'v3') {
    if (runtime.shutdownPromise !== null) {
      return runtime.shutdownPromise
    }
    runtime.shutdownPromise = (async () => {
      await shutdownControlPlaneRuntime(reason, ctx)
      runtime.started = false
    })()
    return runtime.shutdownPromise
  }

  const { shutdownLegacyApplicationRuntime } = await import('./legacy-application-runtime')
  return shutdownLegacyApplicationRuntime(runtime, reason)
}

export function isV3ApplicationRuntime(
  runtime: ApplicationRuntime
): runtime is V3ApplicationRuntime {
  return runtime.kind === 'v3'
}

export function getSchemaRead(ctx: AppContext): SchemaGenerationRead {
  return getApplicationRuntime(ctx).schemaRead
}

export async function resetApplicationRuntimeForTests(ctx: AppContext): Promise<void> {
  const runtime = ctx.applicationRuntime
  if (!runtime) return

  if (runtime.kind === 'v3') {
    await shutdownControlPlaneRuntime('app_shutdown', ctx).catch(() => {})
    runtime.startPromise = null
    runtime.shutdownPromise = null
    runtime.started = false
    return
  }

  const { resetLegacyApplicationRuntimeForTests } = await import('./legacy-application-runtime')
  await resetLegacyApplicationRuntimeForTests(runtime)
}
