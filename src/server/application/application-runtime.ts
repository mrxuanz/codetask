import type { AppContext } from '../context'
import type { ShutdownReason } from './shutdown-types'
import type { StartupCoordinator } from './startup-coordinator'

export interface ApplicationRuntime {
  readonly ctx: AppContext
  readonly startup: StartupCoordinator
  started: boolean
  startPromise: Promise<void> | null
  shutdownPromise: Promise<void> | null
}

export function getApplicationRuntime(ctx: AppContext): ApplicationRuntime {
  if (!ctx.applicationRuntime) {
    throw new Error('Application runtime not bootstrapped')
  }
  return ctx.applicationRuntime
}

export function getApplicationStartup(ctx: AppContext): StartupCoordinator {
  return getApplicationRuntime(ctx).startup
}

async function ensureApplicationRuntime(ctx: AppContext): Promise<ApplicationRuntime> {
  if (ctx.applicationRuntime) {
    return ctx.applicationRuntime
  }
  const { createHostApplicationRuntime } = await import('./host-application-runtime')
  const runtime = createHostApplicationRuntime(ctx)
  ctx.applicationRuntime = runtime
  return runtime
}

export async function startApplicationRuntime(ctx: AppContext): Promise<void> {
  const runtime = await ensureApplicationRuntime(ctx)
  const { startHostApplicationRuntime } = await import('./host-application-runtime')
  return startHostApplicationRuntime(runtime)
}

export async function shutdownApplicationRuntime(
  ctx: AppContext,
  reason: ShutdownReason
): Promise<void> {
  const runtime = ctx.applicationRuntime
  if (!runtime) return

  const { shutdownHostApplicationRuntime } = await import('./host-application-runtime')
  return shutdownHostApplicationRuntime(runtime, reason)
}

export async function resetApplicationRuntimeForTests(ctx: AppContext): Promise<void> {
  const runtime = ctx.applicationRuntime
  if (!runtime) return

  const { resetHostApplicationRuntimeForTests } = await import('./host-application-runtime')
  await resetHostApplicationRuntimeForTests(runtime)
}
