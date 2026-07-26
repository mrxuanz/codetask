import type { Clock } from './ports/clock'
import type { IdGenerator } from './ports/id-generator'
import type { SafeLogger } from './ports/safe-logger'
import type { UnitOfWork } from './ports/unit-of-work'
import type { ProviderRegistryPort } from './ports/provider-registry'
import type { ExecutionRuntimePort } from './ports/execution-runtime'
import type { ArtifactStore } from './ports/artifact-store'
import type { EventPublisher } from './ports/event-publisher'
import type { SkillCatalog } from './skills/catalog'
import type {
  ThreadRepo,
  DraftRepo,
  PlanRepo,
  JobRepo
} from './ports/repositories'
import type { IdempotencyStore } from './idempotency'
import type { TaskProjectionRepo, AttemptRepo } from './ports/task-projection'
import type { WorkspaceLeaseRepo } from './ports/workspace-lease'
import type { VerificationAttemptRepo } from './ports/verification-store'
import type { RetentionStore } from './ports/retention-store'

/**
 * Composition-root dependency bag (重构.md §4.3).
 */
export interface ApplicationDependencies {
  readonly unitOfWork: UnitOfWork
  readonly providers: ProviderRegistryPort
  readonly runtime: ExecutionRuntimePort
  readonly skills: SkillCatalog
  readonly artifacts: ArtifactStore
  readonly clock: Clock
  readonly ids: IdGenerator
  readonly events: EventPublisher
  readonly logger: SafeLogger
  readonly threads: ThreadRepo
  readonly drafts: DraftRepo
  readonly plans: PlanRepo
  readonly jobs: JobRepo
  readonly idempotency: IdempotencyStore
  readonly tasks: TaskProjectionRepo
  readonly attempts: AttemptRepo
  readonly leases: WorkspaceLeaseRepo
  readonly verifications: VerificationAttemptRepo
  readonly retention: RetentionStore
}
