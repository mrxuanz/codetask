import { eq, and } from 'drizzle-orm'
import type { RuntimeInstanceRepository } from '../../../application/ports/runtime-instance-repository'
import type { DbExecutor } from './db-executor'
import { controlRuntimeInstances } from './schema'

export class SqliteRuntimeInstanceRepository implements RuntimeInstanceRepository {
  constructor(private readonly db: DbExecutor) {}

  createRuntimeInstance(input: Parameters<RuntimeInstanceRepository['createRuntimeInstance']>[0]): void {
    this.db
      .insert(controlRuntimeInstances)
      .values({
        id: input.id,
        runId: input.runId,
        state: 'active',
        ownerBootId: input.ownerBootId,
        provider: input.provider,
        pidOrHandleRef: input.pidOrHandleRef ?? null,
        startedAtMs: input.startedAtMs
      })
      .run()
  }

  closeRuntimeInstance(input: Parameters<RuntimeInstanceRepository['closeRuntimeInstance']>[0]): void {
    this.db
      .insert(controlRuntimeInstances)
      .values({
        id: input.id,
        runId: input.runId,
        state: 'closed',
        ownerBootId: 'control-plane',
        startedAtMs: input.closedAtMs,
        closedAtMs: input.closedAtMs,
        exitKind: input.exitKind,
        exitCode: input.exitCode ?? null,
        signal: input.signal ?? null
      })
      .onConflictDoUpdate({
        target: controlRuntimeInstances.id,
        set: {
          state: 'closed',
          closedAtMs: input.closedAtMs,
          exitKind: input.exitKind,
          exitCode: input.exitCode ?? null,
          signal: input.signal ?? null
        }
      })
      .run()
  }

  getActiveInstanceForRun(
    runId: string
  ): { readonly id: string; readonly ownerBootId: string } | null {
    const row = this.db
      .select({
        id: controlRuntimeInstances.id,
        ownerBootId: controlRuntimeInstances.ownerBootId
      })
      .from(controlRuntimeInstances)
      .where(and(eq(controlRuntimeInstances.runId, runId), eq(controlRuntimeInstances.state, 'active')))
      .get()
    return row ?? null
  }

  hasClosedInstanceForRun(runId: string): boolean {
    const row = this.db
      .select({ id: controlRuntimeInstances.id })
      .from(controlRuntimeInstances)
      .where(and(eq(controlRuntimeInstances.runId, runId), eq(controlRuntimeInstances.state, 'closed')))
      .get()
    return row !== undefined
  }
}
