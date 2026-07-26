import type { ApplicationDependencies } from '../../../src/server/core/application/dependencies'
import { EmptySkillCatalog } from '../../../src/server/core/application/skills/catalog'
import {
  FakeExecutionRuntime,
  FakeProvider,
  InMemoryArtifactStore,
  InMemoryAttemptRepo,
  InMemoryDraftRepo,
  InMemoryIdempotencyStore,
  InMemoryJobRepo,
  InMemoryPlanRepo,
  InMemoryProviderRegistry,
  InMemoryRetentionStore,
  InMemoryTaskProjectionRepo,
  InMemoryThreadRepo,
  InMemoryUnitOfWork,
  InMemoryVerificationAttemptRepo,
  InMemoryWorkspaceLeaseRepo,
  RecordingEventPublisher
} from '../../../src/server/adapters/memory/index.ts'
import type { Clock } from '../../../src/server/core/application/ports/clock'
import type { IdGenerator } from '../../../src/server/core/application/ports/id-generator'
import type { SafeLogger } from '../../../src/server/core/application/ports/safe-logger'
import { createTask } from '../../../src/server/core/domain/tasks/index.ts'
import { createJob, type Job } from '../../../src/server/core/domain/jobs/index.ts'
import type { ProjectedTask } from '../../../src/server/core/application/ports/task-projection'

export type TestApplication = ApplicationDependencies & {
  readonly eventPublisher: RecordingEventPublisher
  readonly providerRegistry: InMemoryProviderRegistry
  readonly fakeProvider: FakeProvider
  readonly unitOfWork: InMemoryUnitOfWork
  readonly artifactStore: InMemoryArtifactStore
}

class FixedClock implements Clock {
  constructor(private instant: Date = new Date('2026-07-26T00:00:00.000Z')) {}
  now(): Date {
    return this.instant
  }
  advance(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms)
  }
}

class SeqIdGenerator implements IdGenerator {
  private n = 0
  next(): string {
    this.n += 1
    return `id-${this.n}`
  }
}

const silentLogger: SafeLogger = {
  info() {},
  warn() {},
  error() {}
}

/**
 * Wire in-memory ports for Wave 3/6 application tests.
 * Composition-style helper — application code does not import adapters.
 */
export function createTestApplication(): TestApplication {
  const eventPublisher = new RecordingEventPublisher()
  const unitOfWork = new InMemoryUnitOfWork(eventPublisher)
  const providerRegistry = new InMemoryProviderRegistry()
  const fakeProvider = new FakeProvider('fake')
  providerRegistry.register(fakeProvider)
  const artifactStore = new InMemoryArtifactStore()

  return {
    unitOfWork,
    providers: providerRegistry,
    runtime: new FakeExecutionRuntime(),
    skills: new EmptySkillCatalog(),
    artifacts: artifactStore,
    clock: new FixedClock(),
    ids: new SeqIdGenerator(),
    events: eventPublisher,
    logger: silentLogger,
    threads: new InMemoryThreadRepo(),
    drafts: new InMemoryDraftRepo(),
    plans: new InMemoryPlanRepo(),
    jobs: new InMemoryJobRepo(),
    idempotency: new InMemoryIdempotencyStore(),
    tasks: new InMemoryTaskProjectionRepo(),
    attempts: new InMemoryAttemptRepo(),
    leases: new InMemoryWorkspaceLeaseRepo(),
    verifications: new InMemoryVerificationAttemptRepo(),
    retention: new InMemoryRetentionStore(),
    eventPublisher,
    providerRegistry,
    fakeProvider,
    artifactStore
  }
}

export type SeedJobGraphInput = {
  readonly jobId?: string
  readonly workspaceId?: string
  readonly tasks: readonly {
    readonly id: string
    readonly title?: string
    readonly dependencyIds?: readonly string[]
    readonly sliceId?: string
    readonly milestoneId?: string
  }[]
  readonly status?: Job['status']
}

export type SeedJobGraphResult = {
  readonly job: Job
  readonly workspaceId: string
  readonly tasks: readonly ProjectedTask[]
}

/** Seed a queued job with projected tasks for workflow / fault tests. */
export async function seedJobGraph(
  app: TestApplication,
  input: SeedJobGraphInput
): Promise<SeedJobGraphResult> {
  const jobId = input.jobId ?? app.ids.next()
  const workspaceId = input.workspaceId ?? `ws-${jobId}`
  const job = createJob({
    id: jobId,
    status: input.status ?? 'queued',
    stateRevision: 0,
    executionGeneration: 1,
    planRevision: 1
  })
  await app.jobs.save(job)

  const tasks: ProjectedTask[] = []
  for (const t of input.tasks) {
    const projected: ProjectedTask = {
      jobId,
      executionGeneration: job.executionGeneration,
      task: createTask({
        id: t.id,
        title: t.title ?? t.id,
        dependencyIds: t.dependencyIds ?? []
      }),
      status: 'pending',
      sliceId: t.sliceId ?? 'slice-1',
      milestoneId: t.milestoneId ?? 'milestone-1'
    }
    await app.tasks.save(projected)
    tasks.push(projected)
  }

  return { job, workspaceId, tasks }
}
