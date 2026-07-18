import type Database from 'better-sqlite3'
import type { JobCommandService } from '@shared/contracts/control-plane'
import type { AppContext } from '../context'
import { ensureControlPlaneRuntime } from './control-plane-runtime'
import type { JobQueryService } from './job-query-service'

export type ControlPlaneAppContext = AppContext

export interface ControlPlaneServices {
  readonly commandService: JobCommandService
  readonly queryService: JobQueryService
}

export function getControlPlaneServices(ctx: ControlPlaneAppContext): ControlPlaneServices {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) throw new Error('Control-plane schema is unavailable')
  return runtime
}

/** True when `control_jobs` table exists (migration 027 applied). Safe for legacy-only DBs. */
export function controlJobsTableExists(ctx: ControlPlaneAppContext): boolean {
  try {
    const client = (ctx.db as AppContext['db'] & { $client?: Database.Database }).$client
    if (!client) return false
    const row = client
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'control_jobs'`)
      .get() as { ok: number } | undefined
    return Boolean(row)
  } catch {
    return false
  }
}

/**
 * Safe try-get: returns null on legacy-only DBs or if control-plane services cannot be created.
 * Prefer this over getControlPlaneServices when dual-running with legacy jobs.
 */
export function tryGetControlPlaneServices(
  ctx: ControlPlaneAppContext
): ControlPlaneServices | null {
  if (!controlJobsTableExists(ctx)) {
    return null
  }
  return getControlPlaneServices(ctx)
}

/** Reset cached services (tests only). */
export function resetControlPlaneServicesForTests(): void {
  // Services are owned by ControlPlaneRuntime; its test reset owns lifecycle cleanup.
}
