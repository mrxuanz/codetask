import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { AppContext } from '../context'
import { SqliteJobRepository, type ControlPlaneDatabase } from '../infra/sqlite/control-plane/job-repository'
import { createControlPlaneTransaction } from '../infra/sqlite/control-plane/sqlite-control-plane-unit-of-work'
import type { SqliteTaskRepository } from '../infra/sqlite/control-plane/task-repository'
import { controlPlaneSchema } from '../infra/sqlite/control-plane/schema'
import { getCutoverMarker, type SchemaGeneration } from './cutover-state'
import { EventHub } from './event-hub'
import { createExecutorDependencies } from './executor-adapter'
import { executeRun } from './executor-loop'
import { JobCommandServiceImpl } from './job-command-service'
import { InternalExecutionCommandServiceImpl } from './internal-execution-command-service'
import { JobQueryServiceImpl, type JobQueryService } from './job-query-service'
import { withCommitFlush } from './commit-flushing-unit-of-work'
import { OutboxDispatcher } from './outbox-dispatcher'
import {
  TaskExecutionRegistry,
  createRegistryTaskExecutionProvider
} from './task-execution-registry'
import type { ActorContext } from './ports/job-repository'
import type { OutboxEvent } from './ports/outbox-repository'
import type { JobCommandService, InternalExecutionCommandService, RuntimeExitedPayload } from '@shared/contracts/control-plane'
import { RuntimeSupervisor, type RuntimeExit, type RuntimeHandle } from './runtime-supervisor'
import type { RuntimeProvider, WorkIdentity } from './runtime-provider'
import { SafeLoggerImpl } from './safe-logger'
import { Scheduler, type SchedulerCapabilities } from './scheduler'
import { ShutdownCoordinator, type ShutdownReason } from './shutdown-coordinator'
import { StartupCoordinator } from './startup-coordinator'
import { StartupReconciler } from './startup-reconciler-impl'
import type { SseEnvelope } from '../http/v3/sse-envelope'
import type { RuntimeController } from './ports/runtime-controller'

interface RuntimeBinding {
  readonly jobId: string
  readonly runId: string
  readonly kind: 'planning' | 'execution'
  readonly runtimeInstanceId: string
  readonly closed: Promise<RuntimeExit>
  resolveClosed(exit: RuntimeExit): void
  stopPromise: Promise<void> | null
  closeSettled: boolean
  abortController?: AbortController
}

export interface ControlPlaneRuntime {
  readonly ctx: AppContext
  readonly logger: SafeLoggerImpl
  readonly jobRepository: SqliteJobRepository
  readonly outboxRepository: ReturnType<typeof createControlPlaneTransaction>['outbox']
  readonly slotRepository: ReturnType<typeof createControlPlaneTransaction>['slots']
  readonly runRepository: ReturnType<typeof createControlPlaneTransaction>['runs']
  readonly unitOfWork: ReturnType<typeof createControlPlaneTransaction>
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
  readonly taskExecutionRegistry: TaskExecutionRegistry
  readonly bindingsByRunId: Map<string, RuntimeBinding>
  readonly activeRunByJobId: Map<string, string>
  started: boolean
  startPromise: Promise<void> | null
}

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

function exitKindFromReason(reason: string, exit: RuntimeExit): RuntimeExitedPayload['exitKind'] {
  if (exit.kind === 'error') return 'error'
  if (exit.kind === 'timeout') return 'timeout'
  return reason === 'normal' ? 'normal' : 'signal'
}

async function settleRuntimeExited(
  runtime: ControlPlaneRuntime,
  identity: WorkIdentity,
  runtimeInstanceId: string,
  reason: string,
  exit: RuntimeExit
): Promise<void> {
  const job = runtime.jobRepository.getAggregate(identity.jobId)
  const run = runtime.jobRepository.getActiveRunSummary(identity.runId)

  if (job === null || run === null) {
    runtime.slotRepository.releaseSlot({ runId: identity.runId, releasedAtMs: Date.now() })
    return
  }

  runtime.internalCommandService.runtimeExited({
    jobId: identity.jobId,
    expectedRevision: job.stateRevision,
    runId: identity.runId,
    fenceToken: identity.fenceToken,
    executionGeneration: identity.executionGeneration,
    payload: {
      runtimeInstanceId,
      exitKind: exitKindFromReason(reason, exit),
      ...(exit.exitCode !== undefined ? { exitCode: exit.exitCode } : {}),
      ...(exit.signal !== undefined ? { signal: exit.signal } : reason !== 'normal' ? { signal: reason } : {})
    }
  })
}

async function settleBindingAfterClose(
  runtime: ControlPlaneRuntime,
  binding: RuntimeBinding,
  reason: string,
  exit: RuntimeExit
): Promise<void> {
  if (binding.closeSettled) return
  binding.closeSettled = true

  const run = runtime.jobRepository.getActiveRunSummary(binding.runId)
  const job = runtime.jobRepository.getAggregate(binding.jobId)
  if (run === null || job === null) {
    runtime.slotRepository.releaseSlot({ runId: binding.runId, releasedAtMs: Date.now() })
    settleBinding(runtime, binding, exit)
    return
  }

  const identity: WorkIdentity = {
    jobId: binding.jobId,
    runId: binding.runId,
    fenceToken: run.fenceToken,
    executionGeneration: run.executionGeneration,
    expectedRevision: job.stateRevision
  }

  await settleRuntimeExited(runtime, identity, binding.runtimeInstanceId, reason, exit)
  settleBinding(runtime, binding, exit)
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
      const handle = runtime.runtimeSupervisor.getByRunId(binding.runId)
      if (binding.abortController) {
        binding.abortController.abort(reason)
      }
      if (handle) {
        await handle.requestStop(reason)
      }
      const exit = await binding.closed
      await settleBindingAfterClose(runtime, binding, reason, exit)
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
    requestStop(reason: string): Promise<void> {
      if (binding.abortController) {
        binding.abortController.abort(reason)
      }
      return Promise.resolve()
    },
    async hardKill(reason: string): Promise<void> {
      if (binding.abortController) {
        binding.abortController.abort(reason)
      }
      await stopBinding(runtime, binding, reason)
    }
  }
}

function createV3ExecutorRuntimeProvider(runtime: ControlPlaneRuntime): RuntimeProvider {
  return {
    async start(input): Promise<RuntimeHandle> {
      let resolveClosed!: (exit: RuntimeExit) => void
      const closed = new Promise<RuntimeExit>((resolve) => {
        resolveClosed = resolve
      })
      const abortController = new AbortController()
      input.abortSignal.addEventListener(
        'abort',
        () => {
          resolveClosed({ kind: 'signal', signal: 'aborted' })
        },
        { once: true }
      )

      const binding: RuntimeBinding = {
        jobId: input.jobId,
        runId: input.runId,
        kind: input.kind,
        runtimeInstanceId: randomUUID(),
        closed,
        resolveClosed,
        stopPromise: null,
        closeSettled: false,
        abortController
      }

      runtime.bindingsByRunId.set(input.runId, binding)
      runtime.activeRunByJobId.set(input.jobId, input.runId)

      const handle = createRuntimeHandle(runtime, binding)
      runtime.runtimeSupervisor.register(handle)
      return handle
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
    runtime.logger.error('V3 scheduler rejected unsupported non-execution run', { jobId, runId, kind })
    return
  }

  const job = runtime.jobRepository.getAggregate(jobId)
  const run = runtime.jobRepository.getActiveRunSummary(runId)
  if (job === null || run === null) {
    runtime.logger.error('claimed run disappeared before runtime start', { jobId, runId })
    return
  }

  const workIdentity: WorkIdentity = {
    jobId,
    runId,
    fenceToken: run.fenceToken,
    executionGeneration: run.executionGeneration,
    expectedRevision: job.stateRevision
  }

  const provider = createV3ExecutorRuntimeProvider(runtime)
  const abortController = new AbortController()
  const handle = await provider.start({
    jobId,
    runId,
    kind,
    fenceToken: run.fenceToken,
    executionGeneration: run.executionGeneration,
    abortSignal: abortController.signal
  })

  const binding = runtime.bindingsByRunId.get(runId)
  if (binding === undefined) {
    await handle.hardKill('runtime_start_stale')
    return
  }

  const observedExit = runtime.runtimeSupervisor.observeClosed(handle, async (exit) => {
    await settleBindingAfterClose(runtime, binding, 'normal', exit)
  })

  try {
    runtime.internalCommandService.runtimeStarted({
      jobId,
      expectedRevision: workIdentity.expectedRevision,
      runId,
      fenceToken: workIdentity.fenceToken,
      executionGeneration: workIdentity.executionGeneration,
      payload: {
        runtimeInstanceId: handle.runtimeInstanceId,
        provider: 'v3-executor-loop',
        pidOrHandleRef: `executor:${jobId}`
      }
    })

    const started = runtime.jobRepository.getAggregate(jobId)
    const context = {
      jobId,
      runId,
      fenceToken: workIdentity.fenceToken,
      executionGeneration: workIdentity.executionGeneration,
      expectedRevision: started?.stateRevision ?? workIdentity.expectedRevision,
      workIdentity: '',
      abortSignal: abortController.signal
    }
    const deps = createExecutorDependencies({
      runtime,
      taskExecutionProvider: createRegistryTaskExecutionProvider(runtime.taskExecutionRegistry)
    })
    void executeRun(context, deps, abortController.signal)
      .then(() => {
        binding.resolveClosed({ kind: 'normal' })
      })
      .catch((error: unknown) => {
        runtime.logger.error('V3 executor loop failed', {
          jobId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        })
        binding.resolveClosed({ kind: 'error' })
      })
  } catch (error: unknown) {
    runtime.logger.error('failed to start V3 executor runtime', {
      jobId,
      runId,
      error: error instanceof Error ? error.message : String(error)
    })
    await handle.hardKill('runtime_start_stale')
    throw error
  }

  await observedExit
}

function publishOutboxEvent(runtime: ControlPlaneRuntime, event: OutboxEvent): void {
  runtime.eventHub.publish(toEnvelope(event))
}

function buildRuntimeController(runtime: ControlPlaneRuntime): RuntimeController {
  return {
    notifyPauseRequested(): void {
      // No-op: pause requests are observed via the job repository state,
      // not pushed to the running executor.
    },
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
  const baseControlPlane = createControlPlaneTransaction(cpDb)
  const jobRepository = baseControlPlane.jobs
  const eventHub = new EventHub(
    { maxQueueSize: 512, maxQueueBytes: 1024 * 1024 },
    logger
  )
  const taskExecutionRegistry = new TaskExecutionRegistry()
  const runtimeSupervisor = new RuntimeSupervisor(logger, taskExecutionRegistry)
  // Closures below capture `runtime` by reference; they are only invoked
  // after the assignment further down has run, so this is safe. Must stay
  // `let` (not `const`) because of the definite-assignment split below.
  // eslint-disable-next-line prefer-const
  let runtime!: ControlPlaneRuntime
  const outboxDispatcher = new OutboxDispatcher(
    baseControlPlane.outbox,
    (event) => publishOutboxEvent(runtime, event),
    logger,
    () => Date.now(),
    { batchSize: 100, pollIntervalMs: 250 }
  )
  const controlPlane = withCommitFlush(baseControlPlane, () => outboxDispatcher.flush())
  const schedulerCapabilities: SchedulerCapabilities = {
    planning: false,
    execution: true
  }
  const scheduler = new Scheduler(
    { pollIntervalMs: 1000, maxConcurrentJobs: 4 },
    schedulerCapabilities,
    jobRepository,
    controlPlane,
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
  const taskRepository = controlPlane.tasks
  const commandService = new JobCommandServiceImpl({
    unitOfWork: controlPlane,
    clock: { nowMs: () => Date.now() },
    idGenerator: { generate: () => randomUUID() },
    logger,
    runtimeController
  })
  const internalCommandService = new InternalExecutionCommandServiceImpl({
    unitOfWork: controlPlane,
    clock: { nowMs: () => Date.now() },
    idGenerator: { generate: () => randomUUID() },
    logger
  })
  const queryService = new JobQueryServiceImpl({
    getOwnedJobDetail: (actor, jobId) =>
      jobRepository.getOwnedJobDetail({
        actor: { username: actor.username, requestId: '' },
        jobId
      }),
    listOwnedJobDetails: (actor, options) =>
      jobRepository.listOwnedJobDetails({
        actor: { username: actor.username, requestId: '' },
        ...(options ?? {})
      }),
    listTasksForGeneration: (jobId, executionGeneration) =>
      taskRepository.listTasksForGeneration(jobId, executionGeneration),
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
              controlPlane,
              { nowMs: () => Date.now() },
              { generate: () => randomUUID() },
              logger,
              runtimeSupervisor
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
    outboxRepository: controlPlane.outbox,
    slotRepository: controlPlane.slots,
    runRepository: controlPlane.runs,
    unitOfWork: controlPlane,
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
    taskExecutionRegistry,
    bindingsByRunId: new Map(),
    activeRunByJobId: new Map(),
    started: false,
    startPromise: null
  }

  return runtime
}

export { createControlPlaneRuntime }

export function ensureControlPlaneRuntime(ctx: AppContext): ControlPlaneRuntime | null {
  const applicationRuntime = ctx.applicationRuntime
  if (applicationRuntime === null) {
    return null
  }
  if (applicationRuntime.kind === 'v3') {
    return applicationRuntime.controlPlane
  }
  // Legacy root never owns a V3 control-plane runtime (FIX-PLAN F1).
  return null
}

export async function bootstrapControlPlaneRuntime(ctx: AppContext): Promise<void> {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) {
    return
  }
  if (runtime.startPromise !== null) {
    await runtime.startPromise
    return
  }

  runtime.startPromise = runtime.startup
    .ensureReady()
    .catch((error: unknown) => {
      runtime.startPromise = null
      throw error
    })

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

  return runtime.outboxRepository
    .listOwnedOutboxEvents({ actor, afterEventId, limit })
    .map((event) => toEnvelope(event))
}

export function getControlPlaneLatestEventId(ctx: AppContext, actor: ActorContext): number {
  const runtime = ensureControlPlaneRuntime(ctx)
  if (runtime === null) {
    return 0
  }

  return runtime.outboxRepository.getOwnedOutboxLatestEventId({ actor })
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

export async function shutdownControlPlaneRuntime(
  reason: ShutdownReason,
  ctx?: AppContext
): Promise<void> {
  const { getAppContext } = await import('../bootstrap')
  const appCtx = ctx ?? getAppContext()
  const runtime = ensureControlPlaneRuntime(appCtx)
  if (runtime === null) {
    return
  }

  await runtime.shutdown.shutdown(reason)
  await runtime.outboxDispatcher.stop().catch((error: unknown) => {
    runtime.logger.warn('control-plane outbox dispatcher stop failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  })
  runtime.started = false
}

export async function resetControlPlaneRuntimeForTests(ctx?: AppContext): Promise<void> {
  const { getAppContext } = await import('../bootstrap')
  const appCtx = ctx ?? getAppContext()
  const runtime = ensureControlPlaneRuntime(appCtx)
  if (runtime !== null) {
    await runtime.outboxDispatcher.stop().catch(() => {})
    runtime.startPromise = null
    runtime.started = false
  }
}

/** Composition tests: invoke production runtimeController.closeThenRelease. */
export async function closeProductionRuntimeBinding(
  runtime: ControlPlaneRuntime,
  runId: string,
  reason: string
): Promise<void> {
  await buildRuntimeController(runtime).closeThenRelease(runId, reason)
}
