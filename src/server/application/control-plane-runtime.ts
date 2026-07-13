import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { AppContext } from '../context'
import { threadJobs } from '../db/schema'
import { SqliteJobRepository, type ControlPlaneDatabase } from '../infra/sqlite/control-plane/job-repository'
import { controlPlaneSchema } from '../infra/sqlite/control-plane/schema'
import { pauseJobExecution } from '../jobs/controls'
import { controlJobsTableExists, registerControlPlaneRuntimeController } from './control-plane-services'
import { isV3Authoritative } from './cutover-state'
import { EventHub } from './event-hub'
import { OutboxDispatcher } from './outbox-dispatcher'
import type { ActorContext, OutboxEvent } from './ports/job-repository'
import { RuntimeSupervisor, type RuntimeExit, type RuntimeHandle } from './runtime-supervisor'
import { SafeLoggerImpl } from './safe-logger'
import { Scheduler } from './scheduler'
import { ShutdownCoordinator, type ShutdownReason } from './shutdown-coordinator'
import type { SseEnvelope } from '../http/v3/sse-envelope'

interface RuntimeBinding {
  readonly jobId: string
  readonly runId: string
  readonly username: string
  readonly kind: 'planning' | 'execution'
  readonly runtimeInstanceId: string
  readonly closed: Promise<RuntimeExit>
  resolveClosed(exit: RuntimeExit): void
  startObservedAtMs: number | null
  stopPromise: Promise<void> | null
}

interface ControlPlaneRuntime {
  readonly ctx: AppContext
  readonly logger: SafeLoggerImpl
  readonly jobRepository: SqliteJobRepository
  readonly scheduler: Scheduler
  readonly outboxDispatcher: OutboxDispatcher
  readonly eventHub: EventHub
  readonly runtimeSupervisor: RuntimeSupervisor
  readonly shutdownCoordinator: ShutdownCoordinator
  readonly bindingsByRunId: Map<string, RuntimeBinding>
  readonly activeRunByJobId: Map<string, string>
  started: boolean
  startPromise: Promise<void> | null
}

let runtimeSingleton: ControlPlaneRuntime | null = null

function createControlPlaneDb(appDb: AppContext['db']): ControlPlaneDatabase {
  const client = (appDb as AppContext['db'] & { $client?: Database.Database }).$client
  if (!client) {
    throw new Error('Database client not available')
  }
  return drizzle(client, { schema: controlPlaneSchema })
}

function toEnvelope(event: OutboxEvent): SseEnvelope {
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(event.payloadJson)
    payload =
      parsed !== null && typeof parsed === 'object'
        ? { ...(parsed as Record<string, unknown>) }
        : {}
  } catch {
    payload = {}
  }

  payload = {
    ...payload,
    eventId: event.eventId,
    topic: event.topic,
    type: event.eventType,
    entityId: event.entityId,
    revision: event.aggregateRevision
  }

  return {
    eventId: event.eventId,
    topic: event.topic,
    type: event.eventType,
    entityId: event.entityId,
    revision: event.aggregateRevision,
    payload
  }
}

function settleBinding(runtime: ControlPlaneRuntime, binding: RuntimeBinding, exit: RuntimeExit): void {
  if (runtime.bindingsByRunId.get(binding.runId) !== binding) {
    return
  }
  runtime.bindingsByRunId.delete(binding.runId)
  if (runtime.activeRunByJobId.get(binding.jobId) === binding.runId) {
    runtime.activeRunByJobId.delete(binding.jobId)
  }
  binding.resolveClosed(exit)
}

async function isLegacyRuntimeActive(
  runtime: ControlPlaneRuntime,
  binding: RuntimeBinding
): Promise<boolean> {
  const { findActiveWorkloadRunId } = await import('../jobs/workload-slot-store')
  const physicalRunId = await findActiveWorkloadRunId('thread_job', binding.jobId)
  if (physicalRunId !== null) {
    return true
  }
  if (binding.kind === 'planning') {
    return runtime.ctx.runtimeRegistry.isJobPlanning(binding.jobId)
  }
  return runtime.ctx.executionRuntime.isLoopActive(binding.jobId)
}

function parseLegacyFailureCode(lastError: string | null): string {
  if (!lastError) {
    return 'runtime.exited'
  }
  try {
    const parsed = JSON.parse(lastError) as { code?: string }
    return typeof parsed.code === 'string' && parsed.code.trim() ? parsed.code : 'runtime.exited'
  } catch {
    return 'runtime.exited'
  }
}

async function readLegacyProjection(
  ctx: AppContext,
  jobId: string
): Promise<{
  nextState: 'plan_review' | 'paused' | 'cancelled' | 'failed' | 'succeeded'
  terminalAtMs: number | null
  failureCode: string | null
  changed: Array<'state' | 'failure'>
} | null> {
  const row = await ctx.db
    .select({
      status: threadJobs.status,
      lastError: threadJobs.lastError
    })
    .from(threadJobs)
    .where(eq(threadJobs.id, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  if (!row) return null

  switch (row.status) {
    case 'plan_ready':
    case 'plan_editing':
      return { nextState: 'plan_review', terminalAtMs: null, failureCode: null, changed: ['state'] }
    case 'paused':
    case 'pausing':
      return { nextState: 'paused', terminalAtMs: null, failureCode: null, changed: ['state'] }
    case 'cancelled':
      return { nextState: 'cancelled', terminalAtMs: Date.now(), failureCode: null, changed: ['state'] }
    case 'completed':
      return { nextState: 'succeeded', terminalAtMs: Date.now(), failureCode: null, changed: ['state'] }
    case 'failed':
      return {
        nextState: 'failed',
        terminalAtMs: Date.now(),
        failureCode: parseLegacyFailureCode(row.lastError),
        changed: ['state', 'failure']
      }
    default:
      return null
  }
}

async function settleRuntimeExited(
  runtime: ControlPlaneRuntime,
  binding: RuntimeBinding,
  reason: string
): Promise<void> {
  const job = runtime.jobRepository.getOwnedAggregate({
    actor: { username: 'worker', requestId: 'runtime-bridge-exit' },
    jobId: binding.jobId
  })
  const run = runtime.jobRepository.getActiveRunSummary(binding.runId)

  if (job === null || run === null) {
    runtime.jobRepository.releaseSlot(binding.runId)
    settleBinding(runtime, binding, { kind: 'normal' })
    return
  }

  if (job.state === 'cancelled') {
    runtime.jobRepository.markRunState(binding.runId, 'cancelled', reason)
    runtime.jobRepository.releaseSlot(binding.runId)
    settleBinding(runtime, binding, { kind: 'normal' })
    return
  }

  let nextState: 'plan_review' | 'paused' | 'cancelled' | 'failed' | 'succeeded'
  let terminalAtMs: number | null = null
  let failureId = job.lastFailureId
  let changed: Array<'state' | 'failure'> = ['state']

  if (job.state === 'pausing' && job.controlIntent === 'pause') {
    nextState = 'paused'
  } else {
    const projection = await readLegacyProjection(runtime.ctx, binding.jobId)
    if (projection !== null) {
      nextState = projection.nextState
      terminalAtMs = projection.terminalAtMs
      changed = projection.changed
      if (projection.failureCode) {
        failureId = runtime.jobRepository.insertFailure({
          jobId: binding.jobId,
          code: projection.failureCode,
          recoverability: 'recoverable',
          reason,
          runKind: binding.kind
        })
      }
    } else {
      nextState = 'failed'
      terminalAtMs = Date.now()
      changed = ['state', 'failure']
      failureId = runtime.jobRepository.insertFailure({
        jobId: binding.jobId,
        code: 'run.interrupted',
        recoverability: 'recoverable',
        reason,
        runKind: binding.kind
      })
    }
  }

  const cas = runtime.jobRepository.compareAndSetJob({
    jobId: binding.jobId,
    expectedRevision: job.stateRevision,
    expectedState: job.state,
    expectedActiveRunId: binding.runId,
    next: {
      state: nextState,
      controlIntent: 'none',
      resumeTarget: nextState === 'paused' ? job.resumeTarget : null,
      activeRunId: null,
      lastFailureId: failureId,
      terminalAtMs
    }
  })

  if (cas.ok) {
    const runState =
      nextState === 'paused'
        ? 'paused'
        : nextState === 'cancelled'
          ? 'cancelled'
          : nextState === 'failed'
            ? 'failed'
            : 'succeeded'
    runtime.jobRepository.markRunState(binding.runId, runState, reason)
    runtime.jobRepository.appendOutbox({
      topic: `job:${binding.jobId}`,
      eventType: 'job.changed',
      entityId: binding.jobId,
      aggregateRevision: cas.newRevision,
      payload: {
        type: 'job.changed',
        entityId: binding.jobId,
        revision: cas.newRevision,
        changed
      }
    })
  } else {
    runtime.logger.warn('control-plane runtime exit CAS lost', {
      jobId: binding.jobId,
      runId: binding.runId,
      reason
    })
  }

  runtime.jobRepository.releaseSlot(binding.runId)
  settleBinding(runtime, binding, { kind: 'normal' })
}

async function watchLegacyRuntime(runtime: ControlPlaneRuntime, binding: RuntimeBinding): Promise<void> {
  const startDeadlineMs = Date.now() + 10_000

  for (;;) {
    if (runtime.bindingsByRunId.get(binding.runId) !== binding) {
      return
    }

    const active = await isLegacyRuntimeActive(runtime, binding)
    if (active) {
      binding.startObservedAtMs = Date.now()
    }

    if (binding.startObservedAtMs !== null && !active) {
      await settleRuntimeExited(runtime, binding, 'normal')
      return
    }

    if (binding.startObservedAtMs === null && Date.now() >= startDeadlineMs) {
      runtime.logger.error('legacy runtime never became active for control-plane run', {
        jobId: binding.jobId,
        runId: binding.runId,
        kind: binding.kind
      })
      await settleRuntimeExited(runtime, binding, 'start_timeout')
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function stopBinding(
  runtime: ControlPlaneRuntime,
  binding: RuntimeBinding,
  reason: string
): Promise<void> {
  if (binding.stopPromise !== null) {
    await binding.stopPromise
    return
  }

  binding.stopPromise = (async () => {
    try {
      if (binding.kind === 'planning') {
        runtime.ctx.runtimeRegistry.setPlanningControl(binding.jobId, 'paused')
      } else if (reason === 'paused' || reason === 'pause_requested') {
        pauseJobExecution(binding.jobId)
      }

      const { stopAndReleaseActiveRun } = await import('../jobs/workload-slot-store')
      await stopAndReleaseActiveRun('thread_job', binding.jobId, reason).catch((error: unknown) => {
        runtime.logger.warn('legacy runtime stop failed', {
          jobId: binding.jobId,
          runId: binding.runId,
          error: error instanceof Error ? error.message : String(error)
        })
      })

      const run = runtime.jobRepository.getActiveRunSummary(binding.runId)
      if (run?.state === 'cancelling') {
        runtime.jobRepository.markRunState(binding.runId, 'cancelled', reason)
      }
      runtime.jobRepository.releaseSlot(binding.runId)
      settleBinding(runtime, binding, { kind: 'signal', signal: reason })
    } finally {
      binding.stopPromise = null
    }
  })()

  await binding.stopPromise
}

function createRuntimeHandle(runtime: ControlPlaneRuntime, binding: RuntimeBinding): RuntimeHandle {
  return {
    runtimeInstanceId: binding.runtimeInstanceId,
    runId: binding.runId,
    closed: binding.closed,
    requestStop(reason: string): void {
      void stopBinding(runtime, binding, reason)
    },
    async hardKill(reason: string): Promise<void> {
      await stopBinding(runtime, binding, reason)
    }
  }
}

async function lookupJobOwnerUsername(ctx: AppContext, jobId: string): Promise<string | null> {
  const row = await ctx.db
    .select({ username: threadJobs.username })
    .from(threadJobs)
    .where(eq(threadJobs.id, jobId))
    .limit(1)
    .then((rows) => rows[0] ?? null)

  return row?.username ?? null
}

async function startLegacyRuntime(
  runtime: ControlPlaneRuntime,
  jobId: string,
  runId: string,
  kind: 'planning' | 'execution'
): Promise<void> {
  const username = await lookupJobOwnerUsername(runtime.ctx, jobId)
  if (!username) {
    runtime.logger.warn('control-plane scheduler could not resolve job owner', { jobId, runId, kind })
    runtime.jobRepository.markRunState(runId, 'failed', 'owner_not_found')
    runtime.jobRepository.releaseSlot(runId)
    return
  }

  let resolveClosed!: (exit: RuntimeExit) => void
  const closed = new Promise<RuntimeExit>((resolve) => {
    resolveClosed = resolve
  })

  const binding: RuntimeBinding = {
    jobId,
    runId,
    username,
    kind,
    runtimeInstanceId: randomUUID(),
    closed,
    resolveClosed,
    startObservedAtMs: null,
    stopPromise: null
  }

  runtime.bindingsByRunId.set(runId, binding)
  runtime.activeRunByJobId.set(jobId, runId)
  runtime.runtimeSupervisor.register(createRuntimeHandle(runtime, binding))

  try {
    if (kind === 'planning') {
      const { tryStartDesignSessionPlanning } = await import('../design-session/planner')
      await tryStartDesignSessionPlanning(username, jobId)
    } else {
      const { startPendingExecutionJob } = await import('../jobs/queue-coordinator')
      await startPendingExecutionJob(username, jobId)
    }

    runtime.jobRepository.markRunState(runId, 'active')
    void watchLegacyRuntime(runtime, binding)
  } catch (error: unknown) {
    runtime.logger.error('failed to start legacy runtime for control-plane job', {
      jobId,
      runId,
      kind,
      error: error instanceof Error ? error.message : String(error)
    })
    await settleRuntimeExited(runtime, binding, 'start_failed')
  }
}

function publishOutboxEvent(runtime: ControlPlaneRuntime, event: OutboxEvent): void {
  runtime.eventHub.publish(toEnvelope(event))
}

function buildRuntimeController(runtime: ControlPlaneRuntime) {
  return {
    notifyPauseRequested(jobId: string): void {
      const runId = runtime.activeRunByJobId.get(jobId)
      const binding = runId ? runtime.bindingsByRunId.get(runId) : undefined
      if (binding?.kind === 'planning') {
        runtime.ctx.runtimeRegistry.setPlanningControl(jobId, 'paused')
        return
      }
      pauseJobExecution(jobId)
    },
    async closeThenRelease(runId: string, reason: string): Promise<void> {
      const binding = runtime.bindingsByRunId.get(runId)
      if (binding) {
        await stopBinding(runtime, binding, reason)
        return
      }

      const run = runtime.jobRepository.getActiveRunSummary(runId)
      if (run?.state === 'cancelling') {
        runtime.jobRepository.markRunState(runId, 'cancelled', reason)
      }
      runtime.jobRepository.releaseSlot(runId)
    }
  }
}

function createControlPlaneRuntime(ctx: AppContext): ControlPlaneRuntime | null {
  if (!controlJobsTableExists(ctx)) {
    return null
  }

  const logger = new SafeLoggerImpl()
  const cpDb = createControlPlaneDb(ctx.db)
  const jobRepository = new SqliteJobRepository(cpDb)
  const eventHub = new EventHub(
    { maxQueueSize: 512, maxQueueBytes: 1024 * 1024 },
    logger
  )
  const runtimeSupervisor = new RuntimeSupervisor(logger)
  let runtime!: ControlPlaneRuntime
  const outboxDispatcher = new OutboxDispatcher(
    jobRepository,
    (event) => publishOutboxEvent(runtime, event),
    logger,
    { batchSize: 100, pollIntervalMs: 250 }
  )
  const scheduler = new Scheduler(
    { pollIntervalMs: 1000, maxConcurrentJobs: 4 },
    jobRepository,
    { generate: () => randomUUID() },
    { nowMs: () => Date.now() },
    logger,
    (jobId, runId, kind) => {
      void startLegacyRuntime(runtime, jobId, runId, kind)
    }
  )
  const shutdownCoordinator = new ShutdownCoordinator(
    {
      scheduler,
      outboxDispatcher,
      runtimeSupervisor,
      logger
    },
    { outboxFlushDeadlineMs: 5000 }
  )

  runtime = {
    ctx,
    logger,
    jobRepository,
    scheduler,
    outboxDispatcher,
    eventHub,
    runtimeSupervisor,
    shutdownCoordinator,
    bindingsByRunId: new Map(),
    activeRunByJobId: new Map(),
    started: false,
    startPromise: null
  }

  registerControlPlaneRuntimeController(buildRuntimeController(runtime))
  return runtime
}

export function ensureControlPlaneRuntime(ctx: AppContext): ControlPlaneRuntime | null {
  if (runtimeSingleton !== null) {
    return runtimeSingleton
  }
  runtimeSingleton = createControlPlaneRuntime(ctx)
  return runtimeSingleton
}

export async function bootstrapControlPlaneRuntime(
  ctx: AppContext,
  startupReady: Promise<unknown>
): Promise<void> {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) {
    return
  }
  if (runtime.startPromise !== null) {
    await runtime.startPromise
    return
  }

  runtime.startPromise = (async () => {
    try {
      await startupReady
    } catch (error: unknown) {
      runtime.logger.warn('control-plane runtime start skipped: startup not ready', {
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    if (!isV3Authoritative(ctx.db)) {
      runtime.logger.info('control-plane runtime scheduler remains idle before authoritative cutover')
      return
    }

    await runtime.outboxDispatcher.start()
    await runtime.scheduler.start()
    runtime.started = true
  })()

  await runtime.startPromise
}

export function getControlPlaneReplayEvents(
  ctx: AppContext,
  actor: ActorContext,
  afterEventId: number,
  limit: number
): readonly SseEnvelope[] {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) {
    return []
  }

  return runtime.jobRepository
    .listOwnedOutboxEvents({ actor, afterEventId, limit })
    .map((event) => toEnvelope(event))
}

export function getControlPlaneLatestEventId(ctx: AppContext, actor: ActorContext): number {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) {
    return 0
  }

  return runtime.jobRepository.getOwnedOutboxLatestEventId({ actor })
}

export function subscribeControlPlaneEvents(
  ctx: AppContext,
  actor: ActorContext,
  connectionId: string,
  callback: (event: SseEnvelope) => void
): () => void {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) {
    return () => {}
  }

  return runtime.eventHub.subscribe(connectionId, (event) => {
    const visible = runtime.jobRepository.getOwnedAggregate({
      actor,
      jobId: event.entityId
    })
    if (visible === null) {
      return
    }
    callback(event)
  })
}

export async function shutdownControlPlaneRuntime(reason: ShutdownReason): Promise<void> {
  if (runtimeSingleton === null) {
    return
  }

  await runtimeSingleton.shutdownCoordinator.shutdown(reason)
  await runtimeSingleton.outboxDispatcher.stop().catch((error: unknown) => {
    runtimeSingleton?.logger.warn('control-plane outbox dispatcher stop failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  })
  runtimeSingleton.started = false
}

export async function resetControlPlaneRuntimeForTests(): Promise<void> {
  if (runtimeSingleton !== null) {
    await runtimeSingleton.outboxDispatcher.stop().catch(() => {})
  }
  runtimeSingleton = null
}
