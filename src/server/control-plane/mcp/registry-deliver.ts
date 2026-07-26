import { getAppContext } from '../../bootstrap'
import { ensureControlPlaneRuntime } from '../../application/control-plane-runtime'
import type {
  TaskExecutionOutcome
} from '../../application/ports/task-execution-provider'
import type { TaskExecutionRegistry } from '../../application/task-execution-registry'

let testRegistryOverride: TaskExecutionRegistry | null | undefined

/** Test-only: inject a registry for MCP deliver hooks without AppContext. */
export function setTaskExecutionRegistryForTests(
  registry: TaskExecutionRegistry | null | undefined
): void {
  testRegistryOverride = registry
}

export function resolveTaskExecutionRegistry(): TaskExecutionRegistry | undefined {
  if (testRegistryOverride !== undefined) {
    return testRegistryOverride ?? undefined
  }
  try {
    const runtime = ensureControlPlaneRuntime(getAppContext())
    return runtime?.taskExecutionRegistry
  } catch {
    return undefined
  }
}

/**
 * Deliver an MCP completion into TaskExecutionRegistry when a waiter exists
 * for any of the candidate operation ids (attempt / session / task / idempotency).
 */
export function deliverMcpCompletionToRegistry(
  registry: TaskExecutionRegistry | null | undefined,
  operationIds: readonly string[],
  outcome: TaskExecutionOutcome
): boolean {
  if (!registry) return false
  let delivered = false
  for (const id of operationIds) {
    const trimmed = id.trim()
    if (!trimmed) continue
    if (registry.deliver(trimmed, outcome)) {
      delivered = true
    }
  }
  return delivered
}

export function deliverMcpResultForSession(input: {
  readonly sessionId: string
  readonly taskId?: string
  readonly sliceId?: string
  readonly milestoneId?: string
  readonly idempotencyKey?: string
  readonly raw: unknown
}): boolean {
  const registry = resolveTaskExecutionRegistry()
  const ids = [
    input.idempotencyKey,
    input.sessionId,
    input.taskId,
    input.sliceId,
    input.milestoneId
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  return deliverMcpCompletionToRegistry(registry, ids, {
    kind: 'result',
    raw: input.raw
  })
}
