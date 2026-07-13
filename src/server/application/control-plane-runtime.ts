import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { AppContext } from '../context'
import { SqliteJobRepository, type ControlPlaneDatabase } from '../infra/sqlite/control-plane/job-repository'
import { controlPlaneSchema } from '../infra/sqlite/control-plane/schema'
import { getCutoverMarker, type SchemaGeneration } from './cutover-state'
import { EventHub } from './event-hub'
import { EvidenceRepository } from '../infra/sqlite/control-plane/evidence-repository'
import { VerificationRepository } from '../infra/sqlite/control-plane/verification-repository'
import { SqliteTaskRepository } from '../infra/sqlite/control-plane/task-repository'
import { createExecutorDependencies } from './executor-adapter'
import { executeRun } from './executor-loop'
import { JobCommandServiceImpl } from './job-command-service'
import { InternalExecutionCommandServiceImpl } from './internal-execution-command-service'
import { JobQueryServiceImpl, type JobQueryService } from './job-query-service'
import { OutboxDispatcher } from './outbox-dispatcher'
import type { ActorContext, OutboxEvent } from './ports/job-repository'
import type { JobCommandService, InternalExecutionCommandService } from '@shared/contracts/control-plane'
import { RuntimeSupervisor, type RuntimeExit, type RuntimeHandle } from './runtime-supervisor'
import { SafeLoggerImpl } from './safe-logger'
import { Scheduler } from './scheduler'
import { ShutdownCoordinator, type ShutdownReason } from './shutdown-coordinator'
import { StartupCoordinator } from './startup-coordinator'
import { StartupReconciler } from './startup-reconciler-impl'
import type { SseEnvelope } from '../http/v3/sse-envelope'

interface RuntimeBinding {
  readonly jobId: string
  readonly runId: string
  readonly kind: 'planning' | 'execution'
  readonly runtimeInstanceId: string
  readonly closed: Promise<RuntimeExit>
  resolveClosed(exit: RuntimeExit): void
  stopPromise: Promise<void> | null
  abortController?: AbortController
}

export interface ControlPlaneRuntime {
  readonly ctx: AppContext
  readonly logger: SafeLoggerImpl
  readonly jobRepository: SqliteJobRepository
  readonly taskRepository: SqliteTaskRepository
  readonly commandService: JobCommandService
  readonly internalCommandService: InternalExecutionCommandService
  readonly queryService: JobQueryService
  readonly startup: StartupCoordinator
  readonly shutdown: ShutdownCoordinator
  readonly schemaGeneration: SchemaGeneration
  readonly scheduler: Scheduler
  readonly outboxDispatcher: OutboxDispatcher
  readonly eventHub: EventHub
  readonly runtimeSupervisor: RuntimeSupervisor
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

function controlJobsTableExists(ctx: Pick<AppContext, 'db'>): boolean {
  const client = (ctx.db as AppContext['db'] & { $client?: Database.Database }).$client
  if (!client) return false
  return Boolean(
    client
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'control_jobs'`)
      .get()
  )
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

async function settleRuntimeExited(
  runtime: ControlPlaneRuntime,
  binding: RuntimeBinding,
  reason: string
): Promise<void> {
  const now = Date.now()
  const job = runtime.jobRepository.getAggregate(binding.jobId)
  const run = runtime.jobRepository.getActiveRunSummary(binding.runId)

  if (job === null || run === null) {
    runtime.jobRepository.releaseSlot({ runId: binding.runId, releasedAtMs: now })
    settleBinding(runtime, binding, { kind: 'normal' })
    return
  }

  runtime.internalCommandService.runtimeExited({
    jobId: binding.jobId,
    expectedRevision: job.stateRevision,
    runId: binding.runId,
    fenceToken: run.fenceToken,
    executionGeneration: run.executionGeneration,
    payload: {
      runtimeInstanceId: binding.runtimeInstanceId,
      exitKind: reason === 'normal' ? 'normal' : 'signal',
      ...(reason === 'normal' ? {} : { signal: reason })
    }
  })
  runtime.jobRepository.releaseSlot({ runId: binding.runId, releasedAtMs: now })
  settleBinding(runtime, binding, { kind: 'normal' })
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
      if (binding.abortController) {
        binding.abortController.abort(reason)
        await settleRuntimeExited(runtime, binding, reason)
        return
      }

      await settleRuntimeExited(runtime, binding, reason)
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

async function startV3ExecutorRuntime(
  runtime: ControlPlaneRuntime,
  jobId: string,
  runId: string,
  kind: 'planning' | 'execution'
): Promise<void> {
  if (kind !== 'execution') {
    const now = Date.now()
    runtime.logger.error('V3 scheduler rejected unsupported non-execution run', {
      jobId,
      runId,
      kind
    })
    runtime.jobRepository.markRunState({
      runId,
      state: 'failed',
      stopReason: 'unsupported_v3_run_kind',
      updatedAtMs: now
    })
    runtime.jobRepository.releaseSlot({ runId, releasedAtMs: now })
    return
  }

  let resolveClosed!: (exit: RuntimeExit) => void
  const closed = new Promise<RuntimeExit>((resolve) => {
    resolveClosed = resolve
  })
  const abortController = new AbortController()
  const binding: RuntimeBinding = {
    jobId,
    runId,
    kind,
    runtimeInstanceId: randomUUID(),
    closed,
    resolveClosed,
    stopPromise: null,
    abortController
  }

  runtime.bindingsByRunId.set(runId, binding)
  runtime.activeRunByJobId.set(jobId, runId)
  runtime.runtimeSupervisor.register(createRuntimeHandle(runtime, binding))

  try {
    const job = runtime.jobRepository.getAggregate(jobId)
    const run = runtime.jobRepository.getActiveRunSummary(runId)
    if (job === null || run === null) {
      throw new Error('claimed run disappeared before runtimeStarted')
    }
    const started = runtime.internalCommandService.runtimeStarted({
      jobId,
      expectedRevision: job.stateRevision,
      runId,
      fenceToken: run.fenceToken,
      executionGeneration: run.executionGeneration,
      payload: {
        runtimeInstanceId: binding.runtimeInstanceId,
        provider: 'v3-executor-loop',
        pidOrHandleRef: `executor:${jobId}`
      }
    })
    const context = {
      jobId,
      runId,
      fenceToken: run.fenceToken,
      executionGeneration: run.executionGeneration,
      expectedRevision: started.revision,
      workIdentity: ''
    }
    const deps = createExecutorDependencies(runtime, context)
    void executeRun(context, deps, abortController.signal)
      .catch((error: unknown) => {
        runtime.logger.error('V3 executor loop failed', {
          jobId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => settleRuntimeExited(runtime, binding, 'normal'))
  } catch (error: unknown) {
    runtime.logger.error('failed to start V3 executor runtime', {
      jobId,
      runId,
      error: error instanceof Error ? error.message : String(error)
    })
    await createRuntimeHandle(runtime, binding).hardKill('runtime_start_stale')
  }
}

function publishOutboxEvent(runtime: ControlPlaneRuntime, event: OutboxEvent): void {
  runtime.eventHub.publish(toEnvelope(event))
}

function buildRuntimeController(runtime: ControlPlaneRuntime) {
  return {
    notifyPauseRequested(): void {},
    async closeThenRelease(runId: string, reason: string): Promise<void> {
      const binding = runtime.bindingsByRunId.get(runId)
      if (binding) {
        await stopBinding(runtime, binding, reason)
        return
      }

      runtime.logger.warn('runtime stop requested without an observed handle; retaining slot', {
        runId,
        reason
      })
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
    () => Date.now(),
    { batchSize: 100, pollIntervalMs: 250 }
  )
  const scheduler = new Scheduler(
    { pollIntervalMs: 1000, maxConcurrentJobs: 4 },
    jobRepository,
    { generate: () => randomUUID() },
    { nowMs: () => Date.now() },
    logger,
    (jobId, runId, kind) => {
      if (runtime.schemaGeneration === 'v3_authoritative') {
        void startV3ExecutorRuntime(runtime, jobId, runId, kind)
      }
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
  const runtimeController = buildRuntimeController(runtime)
  const taskRepository = new SqliteTaskRepository(cpDb)
  const evidenceRepository = new EvidenceRepository(cpDb)
  const commandService = new JobCommandServiceImpl({
    jobRepository,
    unitOfWork: jobRepository,
    taskRepository,
    evidenceRepository,
    clock: { nowMs: () => Date.now() },
    idGenerator: { generate: () => randomUUID() },
    logger,
    runtimeController
  })
  const internalCommandService = new InternalExecutionCommandServiceImpl({
    jobRepository,
    verificationRepository: new VerificationRepository(cpDb),
    evidenceRepository,
    clock: { nowMs: () => Date.now() },
    idGenerator: { generate: () => randomUUID() },
    logger
  })
  const queryService = new JobQueryServiceImpl({
    getJobAggregate: (actor, jobId) =>
      jobRepository.getOwnedAggregate({ actor: { username: actor.username, requestId: '' }, jobId }),
    listJobAggregates: (actor, projectId) =>
      jobRepository.listOwnedAggregates({
        actor: { username: actor.username, requestId: '' },
        ...(projectId === undefined ? {} : { projectId })
      }),
    getLegacyJobSnapshot: async () => null,
    listLegacyJobSnapshots: async () => ({ jobs: [], total: 0 }),
    getJobTimestamps: (jobId) => jobRepository.getJobTimestamps(jobId),
    getJobFailure: (failureId) => jobRepository.getJobFailure(failureId)
  })
  const startup = new StartupCoordinator({
    logger,
    stages: [
      {
        name: 'control-schema-invariants',
        async execute() {
          const client = (ctx.db as AppContext['db'] & { $client?: Database.Database }).$client
          if (!client) throw new Error('Database client not available')
          if (!client.pragma('foreign_keys', { simple: true })) {
            throw new Error('SQLite foreign keys must be enabled')
          }
          if (!controlJobsTableExists(ctx)) throw new Error('Control-plane schema is unavailable')
        }
      },
      {
        name: 'control-plane-reconcile',
        execute: async () => {
          if (runtime.schemaGeneration === 'v3_authoritative') {
            await new StartupReconciler(
              jobRepository,
              { nowMs: () => Date.now() },
              { generate: () => randomUUID() },
              logger
            ).reconcileAll()
          }
        }
      },
      {
        name: 'control-outbox',
        execute: () => outboxDispatcher.start()
      }
    ]
  })

  runtime = {
    ctx,
    logger,
    jobRepository,
    taskRepository,
    commandService,
    internalCommandService,
    queryService,
    startup,
    shutdown: shutdownCoordinator,
    schemaGeneration: getCutoverMarker(ctx.db),
    scheduler,
    outboxDispatcher,
    eventHub,
    runtimeSupervisor,
    bindingsByRunId: new Map(),
    activeRunByJobId: new Map(),
    started: false,
    startPromise: null
  }

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
  startupReady?: Promise<unknown>
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
    if (startupReady) {
      await startupReady
    }
    await runtime.startup.ensureReady()
  })()

  await runtime.startPromise
}

/** Starts scheduling only after DB facts, reconciliation, and outbox are ready. */
export async function startControlPlaneScheduler(ctx: AppContext): Promise<void> {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) return
  await bootstrapControlPlaneRuntime(ctx)
  if (runtime.schemaGeneration !== 'v3_authoritative') {
    runtime.logger.info('control-plane scheduler remains idle before authoritative cutover', {
      schemaGeneration: runtime.schemaGeneration
    })
    return
  }
  await runtime.scheduler.start()
  runtime.started = true
}

export function getControlPlaneRuntime(ctx: AppContext): ControlPlaneRuntime {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) throw new Error('Control-plane schema is unavailable')
  return runtime
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
  callback: (event: SseEnvelope) => void,
  onOverflow?: (info: { readonly lastDeliveredEventId: number; readonly latestEventId: number }) => void
): () => void {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) {
    return () => {}
  }

  return runtime.eventHub.subscribe(
    connectionId,
    (event) => {
      const visible = runtime.jobRepository.getOwnedAggregate({
        actor,
        jobId: event.entityId
      })
      if (visible === null) {
        return
      }
      callback(event)
    },
    onOverflow
  )
}

export async function shutdownControlPlaneRuntime(reason: ShutdownReason): Promise<void> {
  if (runtimeSingleton === null) {
    return
  }

  await runtimeSingleton.shutdown.shutdown(reason)
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
