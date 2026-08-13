import type {
  DraftReference,
  ExecutionTreeSnapshot,
  ExecutionTask,
  JobSubmission,
  ProviderCode,
  ReferenceManifest
} from '@codetask/contracts'
import { findExecutionTreeLimitViolation, MAX_JOB_SUBMISSION_BYTES } from '@codetask/contracts'
import type Database from 'better-sqlite3'
import {
  canonicalizeWorkspaceRoot,
  ExecutionConflictError,
  ExecutionValidationError,
  isoFromMs,
  newId,
  nowMs,
  stableHash
} from '../../shared.ts'
import { hasCycle } from '../../work/domain/dependency-graph.ts'
import type { SliceDependencyRecord, WorkDependencyRecord } from '../../work/domain/work-item.ts'
import { hashSubmission, JobSubmissionDedup } from '../infrastructure/job-submission-dedup.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'

const VALID_PROVIDERS = new Set<ProviderCode>(['opencode', 'cursor', 'codex', 'claude'])

export function normalizeProvider(coreCode: string): ProviderCode {
  const lower = coreCode.toLowerCase() as ProviderCode
  if (!VALID_PROVIDERS.has(lower)) {
    throw new ExecutionValidationError(`Unsupported Provider: ${coreCode}`)
  }
  return lower
}

function allNodesConfirmed(tree: ExecutionTreeSnapshot): boolean {
  for (const milestone of tree.milestones) {
    if (!milestone.confirmed) return false
    for (const slice of milestone.slices) {
      if (!slice.confirmed) return false
      for (const task of slice.tasks) {
        if (!task.confirmed) return false
      }
    }
  }
  return tree.milestones.length > 0
}

function collectTasks(tree: ExecutionTreeSnapshot): ExecutionTask[] {
  const tasks: ExecutionTask[] = []
  for (const milestone of tree.milestones) {
    for (const slice of milestone.slices) {
      tasks.push(...slice.tasks)
    }
  }
  return tasks
}

function validateExecutionTreeShape(tree: ExecutionTreeSnapshot): void {
  const nodeIds = new Set<string>()
  const requireUnique = (id: string, label: string): void => {
    if (!id.trim()) throw new ExecutionValidationError(`${label} id is required`)
    if (nodeIds.has(id)) throw new ExecutionValidationError(`Duplicate execution node id: ${id}`)
    nodeIds.add(id)
  }

  if (tree.milestones.length === 0) {
    throw new ExecutionValidationError('Execution tree must contain a milestone')
  }
  for (const milestone of tree.milestones) {
    requireUnique(milestone.id, 'Milestone')
    if (milestone.slices.length === 0) {
      throw new ExecutionValidationError(`Milestone ${milestone.id} has no slices`)
    }
    for (const slice of milestone.slices) {
      requireUnique(slice.id, 'Slice')
      if (slice.milestoneId !== milestone.id) {
        throw new ExecutionValidationError(`Slice ${slice.id} has an invalid milestoneId`)
      }
      if (slice.tasks.length === 0) {
        throw new ExecutionValidationError(`Slice ${slice.id} has no tasks`)
      }
      for (const task of slice.tasks) {
        requireUnique(task.id, 'Task')
        if (task.sliceId !== slice.id) {
          throw new ExecutionValidationError(`Task ${task.id} has an invalid sliceId`)
        }
        normalizeProvider(task.coreCode)
      }
    }
  }
}

function validateSubmissionConsistency(submission: JobSubmission): void {
  const snapshot = submission.draftSnapshot
  if (snapshot.actorId !== submission.actorId) {
    throw new ExecutionValidationError('Draft snapshot actor does not match submission actor')
  }
  if (snapshot.projectId !== submission.projectId) {
    throw new ExecutionValidationError('Draft snapshot project does not match submission project')
  }
  if (snapshot.draftId !== submission.source.draftId) {
    throw new ExecutionValidationError('Draft snapshot does not match source draft')
  }
  if (
    canonicalizeWorkspaceRoot(snapshot.workspaceRoot) !==
    canonicalizeWorkspaceRoot(submission.workspaceRoot)
  ) {
    throw new ExecutionValidationError('Draft snapshot workspace does not match submission')
  }
  if (submission.referenceManifest.draftId !== submission.source.draftId) {
    throw new ExecutionValidationError('Reference manifest does not match source draft')
  }
  if (submission.referenceManifest.draftLockRevision !== snapshot.lockRevision) {
    throw new ExecutionValidationError('Reference manifest lock revision does not match draft')
  }
  if (submission.executionTree.planningSessionId !== submission.source.planningSessionId) {
    throw new ExecutionValidationError('Execution tree does not match planning session')
  }

  const referenceIds = new Set<string>()
  for (const reference of submission.referenceManifest.references) {
    if (!reference.id.trim()) {
      throw new ExecutionValidationError('Reference id is required')
    }
    if (referenceIds.has(reference.id)) {
      throw new ExecutionValidationError(`Duplicate reference id: ${reference.id}`)
    }
    referenceIds.add(reference.id)
  }
  for (const task of collectTasks(submission.executionTree)) {
    const seen = new Set<string>()
    for (const referenceId of task.referenceIds) {
      if (seen.has(referenceId)) {
        throw new ExecutionValidationError(
          `Task ${task.id} contains duplicate reference: ${referenceId}`
        )
      }
      seen.add(referenceId)
      if (!referenceIds.has(referenceId)) {
        throw new ExecutionValidationError(
          `Task ${task.id} references missing manifest entry: ${referenceId}`
        )
      }
    }
  }
}

function materializeDependencies(input: {
  jobId: string
  generation: number
  tree: ExecutionTreeSnapshot
  taskIdToWorkId: Map<string, string>
}): WorkDependencyRecord[] {
  const deps: WorkDependencyRecord[] = []
  const taskIds = new Set(collectTasks(input.tree).map((t) => t.id))

  for (const milestone of input.tree.milestones) {
    for (const slice of milestone.slices) {
      let previousWorkId: string | null = null
      for (const task of slice.tasks) {
        const fromWorkId = input.taskIdToWorkId.get(task.id)!
        for (const depTaskId of task.dependsOnTaskIds) {
          if (!taskIds.has(depTaskId)) {
            throw new ExecutionValidationError(`Missing dependency task: ${depTaskId}`)
          }
          const dependsOnWorkId = input.taskIdToWorkId.get(depTaskId)!
          deps.push({
            jobId: input.jobId,
            generation: input.generation,
            fromWorkId,
            dependsOnWorkId,
            reason: 'planner'
          })
        }
        if (!task.canRunInParallel && task.dependsOnTaskIds.length === 0 && previousWorkId) {
          deps.push({
            jobId: input.jobId,
            generation: input.generation,
            fromWorkId,
            dependsOnWorkId: previousWorkId,
            reason: 'implicit-order'
          })
        }
        previousWorkId = fromWorkId
      }
    }
  }

  const workIds = [...input.taskIdToWorkId.values()]
  if (hasCycle(workIds, deps)) {
    throw new ExecutionValidationError('Execution tree has cyclic dependencies')
  }
  return deps
}

function materializeSliceDependencies(input: {
  jobId: string
  generation: number
  tree: ExecutionTreeSnapshot
  sliceIdToJobSliceId: Map<string, string>
}): SliceDependencyRecord[] {
  const sourceSliceIds = new Set(input.sliceIdToJobSliceId.keys())
  const edges = new Map<string, string[]>()
  const dependencies: SliceDependencyRecord[] = []
  for (const milestone of input.tree.milestones) {
    for (const slice of milestone.slices) {
      const dependencyIds = slice.dependsOnSliceIds ?? []
      edges.set(slice.id, dependencyIds)
      for (const dependencyId of dependencyIds) {
        if (!sourceSliceIds.has(dependencyId)) {
          throw new ExecutionValidationError(`Missing dependency slice: ${dependencyId}`)
        }
        dependencies.push({
          jobId: input.jobId,
          generation: input.generation,
          fromSliceId: input.sliceIdToJobSliceId.get(slice.id)!,
          dependsOnSliceId: input.sliceIdToJobSliceId.get(dependencyId)!
        })
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (sliceId: string): void => {
    if (visiting.has(sliceId)) {
      throw new ExecutionValidationError('Execution tree has cyclic slice dependencies')
    }
    if (visited.has(sliceId)) return
    visiting.add(sliceId)
    for (const dependencyId of edges.get(sliceId) ?? []) visit(dependencyId)
    visiting.delete(sliceId)
    visited.add(sliceId)
  }
  for (const sliceId of sourceSliceIds) visit(sliceId)
  return dependencies
}

export type SubmitJobService = {
  accept(submission: JobSubmission): Promise<{
    submissionId: string
    jobId: string
    acceptedAt: string
  }>
}

export type JobAssetPort = {
  prepareReferences(input: {
    actorId: string
    projectId: string
    draftId: string
    references: DraftReference[]
  }): DraftReference[]
  promoteReferences(input: { jobId: string; draftId: string; references: DraftReference[] }): void
  releaseJob(jobId: string): void
  resolveAttachmentPath(attachmentId: string): string | null
  onReferencesReleased?(): void
}

export function createSubmitJobService(deps: {
  db: Database.Database
  outbox: ExecutionOutbox
  assets?: JobAssetPort
}): SubmitJobService {
  const dedup = new JobSubmissionDedup(deps.db)

  return {
    async accept(submission) {
      const submissionHash = hashSubmission(submission)
      const bySubmissionId = dedup.checkSubmissionId(submission.submissionId)
      if (bySubmissionId) {
        if (bySubmissionId.submissionHash !== submissionHash) {
          throw new ExecutionConflictError('Submission id reused with different payload')
        }
        return {
          submissionId: submission.submissionId,
          jobId: bySubmissionId.jobId,
          acceptedAt: isoFromMs(bySubmissionId.acceptedAt)
        }
      }

      const idem = dedup.checkIdempotency(submission.idempotencyKey, submissionHash)
      dedup.assertNoConflict(idem)
      if (idem.kind === 'replay') {
        return {
          submissionId: submission.submissionId,
          jobId: idem.jobId,
          acceptedAt: isoFromMs(idem.acceptedAt)
        }
      }

      if (!allNodesConfirmed(submission.executionTree)) {
        throw new ExecutionValidationError('All tree nodes must be confirmed')
      }
      const submissionBytes = new TextEncoder().encode(JSON.stringify(submission)).byteLength
      if (submissionBytes > MAX_JOB_SUBMISSION_BYTES) {
        throw new ExecutionValidationError(
          `Job submission exceeds ${MAX_JOB_SUBMISSION_BYTES} bytes`
        )
      }
      const limitViolation = findExecutionTreeLimitViolation(submission.executionTree)
      if (limitViolation) throw new ExecutionValidationError(limitViolation)
      validateSubmissionConsistency(submission)
      validateExecutionTreeShape(submission.executionTree)

      const preparedReferences =
        deps.assets?.prepareReferences({
          actorId: submission.actorId,
          projectId: submission.projectId,
          draftId: submission.source.draftId,
          references: submission.referenceManifest.references
        }) ?? submission.referenceManifest.references
      const preparedManifest: ReferenceManifest = {
        ...submission.referenceManifest,
        references: preparedReferences
      }
      const preparedDraftSnapshot = {
        ...submission.draftSnapshot,
        references: submission.draftSnapshot.references.map(
          (reference) =>
            preparedReferences.find((candidate) => candidate.id === reference.id) ?? reference
        )
      }

      const jobId = newId('job')
      const now = nowMs()
      const generation = 0
      const canonicalRoot = canonicalizeWorkspaceRoot(submission.workspaceRoot)
      const contentHash = stableHash(JSON.stringify(submission.executionTree))
      const settingsHash = submission.executionSettings.settingsHash
      const sequence = deps.db
        .prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM execution_queue_entries`)
        .get() as { next: number }

      const taskIdToWorkId = new Map<string, string>()
      const milestoneIdToJobMilestoneId = new Map<string, string>()
      const sliceIdToJobSliceId = new Map<string, string>()
      for (const milestone of submission.executionTree.milestones) {
        milestoneIdToJobMilestoneId.set(milestone.id, newId('jm'))
        for (const slice of milestone.slices) {
          sliceIdToJobSliceId.set(slice.id, newId('js'))
          for (const task of slice.tasks) {
            taskIdToWorkId.set(task.id, `work_${jobId}_${task.id}`)
          }
        }
      }

      const dependencies = materializeDependencies({
        jobId,
        generation,
        tree: submission.executionTree,
        taskIdToWorkId
      })
      const sliceDependencies = materializeSliceDependencies({
        jobId,
        generation,
        tree: submission.executionTree,
        sliceIdToJobSliceId
      })

      const tx = deps.db.transaction(() => {
        deps.db
          .prepare(
            `INSERT INTO jobs (
              id, submission_id, submission_hash, idempotency_key, actor_id, project_id,
              source_draft_id, source_planning_session_id, title, summary,
              workspace_root, canonical_workspace_root, state, state_revision, control_intent,
              execution_generation, queued_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'none', ?, ?, ?, ?)`
          )
          .run(
            jobId,
            submission.submissionId,
            submissionHash,
            submission.idempotencyKey,
            submission.actorId,
            submission.projectId,
            submission.source.draftId,
            submission.source.planningSessionId,
            submission.title,
            submission.summary,
            submission.workspaceRoot,
            canonicalRoot,
            generation,
            now,
            now,
            now
          )

        deps.assets?.promoteReferences({
          jobId,
          draftId: submission.source.draftId,
          references: preparedReferences
        })

        deps.db
          .prepare(
            `INSERT INTO job_snapshots (
              job_id, draft_snapshot_json, execution_profile_json,
              execution_settings_snapshot_json, reference_manifest_json,
              execution_tree_json, settings_hash, content_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            jobId,
            JSON.stringify(preparedDraftSnapshot),
            JSON.stringify(submission.executionProfile),
            JSON.stringify(submission.executionSettings),
            JSON.stringify(preparedManifest),
            JSON.stringify(submission.executionTree),
            settingsHash,
            contentHash,
            now
          )

        let milestoneSort = 0
        for (const milestone of submission.executionTree.milestones) {
          const milestoneId = milestoneIdToJobMilestoneId.get(milestone.id)!
          deps.db
            .prepare(
              `INSERT INTO job_milestones (
                id, job_id, generation, source_milestone_id, sort_order,
                title, description, success_criteria, state
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
            )
            .run(
              milestoneId,
              jobId,
              generation,
              milestone.id,
              milestoneSort,
              milestone.title,
              milestone.description,
              milestone.successCriteria
            )
          milestoneSort += 1

          let sliceSort = 0
          for (const slice of milestone.slices) {
            const sliceId = sliceIdToJobSliceId.get(slice.id)!
            deps.db
              .prepare(
                `INSERT INTO job_slices (
                  id, job_id, generation, milestone_id, source_slice_id, sort_order,
                  title, description, success_criteria, state, verification_state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending')`
              )
              .run(
                sliceId,
                jobId,
                generation,
                milestoneId,
                slice.id,
                sliceSort,
                slice.title,
                slice.description,
                slice.successCriteria
              )
            sliceSort += 1

            let taskSort = 0
            for (const task of slice.tasks) {
              const workId = taskIdToWorkId.get(task.id)!
              deps.db
                .prepare(
                  `INSERT INTO job_work_items (
                    id, job_id, generation, source_task_id, parent_work_id,
                    milestone_id, slice_id, kind, task_kind, sort_order, title, description,
                    context_markdown, ability_code, provider_code, success_criteria,
                    reference_reason, required_inputs_json, can_run_in_parallel,
                    state, state_revision, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
                )
                .run(
                  workId,
                  jobId,
                  generation,
                  task.id,
                  milestoneId,
                  sliceId,
                  task.taskKind ?? 'general-implementation',
                  taskSort,
                  task.title,
                  task.description,
                  task.contextMarkdown,
                  task.abilityCode,
                  normalizeProvider(task.coreCode),
                  task.successCriteria,
                  task.referenceReason ?? '',
                  JSON.stringify(task.requiredInputs ?? []),
                  task.canRunInParallel ? 1 : 0,
                  now,
                  now
                )

              for (const refId of task.referenceIds) {
                deps.db
                  .prepare(
                    `INSERT INTO job_work_references (job_id, generation, work_id, reference_id)
                     VALUES (?, ?, ?, ?)`
                  )
                  .run(jobId, generation, workId, refId)
              }
              taskSort += 1
            }
          }
        }

        for (const dependency of sliceDependencies) {
          deps.db
            .prepare(
              `INSERT INTO job_slice_dependencies (
                job_id, generation, from_slice_id, depends_on_slice_id
              ) VALUES (?, ?, ?, ?)`
            )
            .run(
              dependency.jobId,
              dependency.generation,
              dependency.fromSliceId,
              dependency.dependsOnSliceId
            )
        }

        for (const dep of dependencies) {
          deps.db
            .prepare(
              `INSERT INTO job_work_dependencies (
                job_id, generation, from_work_id, depends_on_work_id, reason
              ) VALUES (?, ?, ?, ?, ?)`
            )
            .run(dep.jobId, dep.generation, dep.fromWorkId, dep.dependsOnWorkId, dep.reason)
        }

        deps.db
          .prepare(
            `INSERT INTO execution_queue_entries (
              job_id, generation, status, priority, sequence, enqueued_at
            ) VALUES (?, ?, 'queued', 0, ?, ?)`
          )
          .run(jobId, generation, sequence.next, now)

        deps.outbox.enqueue(
          jobId,
          'job.submitted',
          {
            jobId,
            actorId: submission.actorId,
            submissionId: submission.submissionId,
            state: 'queued',
            revision: 0
          },
          deps.db
        )
      })

      tx()

      return {
        submissionId: submission.submissionId,
        jobId,
        acceptedAt: isoFromMs(now)
      }
    }
  }
}
