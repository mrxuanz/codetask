/**
 * Row-level repository ports for the new-core SQLite adapter (Wave 4).
 *
 * Domain-shaped get/save ports live in `core/application/ports/repositories.ts`
 * (ThreadRepo / DraftRepo / PlanRepo / JobRepo) and are implemented by
 * `domain-repositories.ts`. These row ports add CAS, outbox claim/ack, plan
 * graph, tasks, and artifact metadata that the domain ports do not yet cover.
 */

export type CasResult =
  | { readonly ok: true; readonly newRevision: number }
  | { readonly ok: false; readonly reason: 'revision_conflict' }

export interface CoreThreadRecord {
  readonly id: string
  readonly projectId: string
  readonly ownerUserId: string
  readonly status: string
  readonly revision: number
  readonly draftId: string | null
  readonly planId: string | null
  readonly jobId: string | null
  readonly title: string | null
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CoreDraftRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly status: string
  readonly revision: number
  readonly content: string
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CorePlanRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly draftId: string | null
  readonly status: string
  readonly revision: number
  readonly executionGeneration: number
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CorePlanNodeRecord {
  readonly id: string
  readonly planId: string
  readonly kind: string
  readonly title: string
  readonly parentId: string | null
  readonly sortOrder: number
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CorePlanEdgeRecord {
  readonly planId: string
  readonly fromNodeId: string
  readonly toNodeId: string
}

export interface CoreJobRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly planId: string | null
  /** Single authoritative status column (重构.md §9.3). */
  readonly status: string
  readonly revision: number
  readonly planRevision: number
  readonly executionGeneration: number
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly terminalAtMs: number | null
}

export interface CoreTaskRecord {
  readonly id: string
  readonly projectId: string
  readonly jobId: string
  readonly planNodeId: string | null
  readonly status: string
  readonly revision: number
  readonly title: string | null
  readonly dependencyIdsJson: string
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CoreTaskAttemptRecord {
  readonly id: string
  readonly taskId: string
  readonly jobId: string
  readonly status: string
  readonly executionGeneration: number
  readonly idempotencyKey: string
  readonly resultHash: string | null
  readonly errorCode: string | null
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CoreOutboxRecord {
  readonly id: number
  readonly topic: string
  readonly eventType: string
  readonly entityId: string
  readonly aggregateRevision: number
  readonly payloadJson: string
  readonly status: string
  readonly claimedBy: string | null
  readonly claimedAtMs: number | null
  readonly availableAtMs: number
  readonly createdAtMs: number
  readonly ackedAtMs: number | null
}

export interface CoreArtifactRecord {
  readonly id: string
  readonly projectId: string
  readonly jobId: string | null
  readonly kind: string
  readonly storagePath: string
  readonly contentSha256: string
  readonly byteSize: number
  readonly payloadJson: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly expiresAtMs: number | null
  readonly deletedAtMs: number | null
}

export interface ThreadRepository {
  get(id: string): CoreThreadRecord | null
  save(row: CoreThreadRecord): void
  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CoreThreadRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult
}

export interface DraftRepository {
  get(id: string): CoreDraftRecord | null
  save(row: CoreDraftRecord): void
  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CoreDraftRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult
}

export interface PlanRepository {
  get(id: string): CorePlanRecord | null
  save(row: CorePlanRecord): void
  replaceGraph(input: {
    readonly plan: CorePlanRecord
    readonly nodes: readonly CorePlanNodeRecord[]
    readonly edges: readonly CorePlanEdgeRecord[]
  }): void
  listNodes(planId: string): readonly CorePlanNodeRecord[]
  listEdges(planId: string): readonly CorePlanEdgeRecord[]
  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CorePlanRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult
}

export interface JobRepository {
  get(id: string): CoreJobRecord | null
  save(row: CoreJobRecord): void
  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly expectedStatus?: string
    readonly next: {
      readonly status: string
      readonly planRevision?: number
      readonly executionGeneration?: number
      readonly payloadJson?: string
      readonly terminalAtMs?: number | null
      readonly updatedAtMs: number
      readonly planId?: string | null
    }
  }): CasResult
}

export interface TaskRepository {
  get(id: string): CoreTaskRecord | null
  save(row: CoreTaskRecord): void
  listByJob(jobId: string): readonly CoreTaskRecord[]
  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CoreTaskRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult
}

export interface AttemptRepository {
  get(id: string): CoreTaskAttemptRecord | null
  save(row: CoreTaskAttemptRecord): void
  listForTask(
    jobId: string,
    taskId: string,
    executionGeneration: number
  ): readonly CoreTaskAttemptRecord[]
  listNonTerminal(): readonly CoreTaskAttemptRecord[]
}

export interface OutboxRepository {
  append(input: {
    readonly topic: string
    readonly eventType: string
    readonly entityId: string
    readonly aggregateRevision: number
    readonly payloadJson: string
    readonly createdAtMs: number
    readonly availableAtMs?: number
  }): number
  claim(input: {
    readonly limit: number
    readonly claimedBy: string
    readonly nowMs: number
  }): readonly CoreOutboxRecord[]
  ack(input: { readonly ids: readonly number[]; readonly ackedAtMs: number }): void
  listPending(limit: number): readonly CoreOutboxRecord[]
}

export interface ArtifactRepository {
  get(id: string): CoreArtifactRecord | null
  /** Metadata only — never stores file bytes. */
  saveMeta(row: CoreArtifactRecord): void
  softDelete(input: { readonly id: string; readonly deletedAtMs: number }): void
}

export interface CoreRepositories {
  readonly threads: ThreadRepository
  readonly drafts: DraftRepository
  readonly plans: PlanRepository
  readonly jobs: JobRepository
  readonly tasks: TaskRepository
  readonly outbox: OutboxRepository
  readonly artifacts: ArtifactRepository
}
