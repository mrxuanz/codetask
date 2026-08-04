import type {
  ExecutionTreeSnapshot,
  ExecutionTask,
  JobSubmission,
  ProviderCode
} from '@codetask/contracts'
import type Database from 'better-sqlite3'
import {
  canonicalizeWorkspaceRoot,
  ExecutionValidationError,
  isoFromMs,
  newId,
  nowMs,
  stableHash
} from '../../shared.ts'
import { hasCycle } from '../../work/domain/dependency-graph.ts'
import type { WorkDependencyRecord } from '../../work/domain/work-item.ts'
import { hashSubmission, JobSubmissionDedup } from '../infrastructure/job-submission-dedup.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'

const VALID_PROVIDERS = new Set<ProviderCode>(['opencode', 'cursor', 'codex', 'claude'])

export function normalizeProvider(coreCode: string): ProviderCode {
  const lower = coreCode.toLowerCase() as ProviderCode
  return VALID_PROVIDERS.has(lower) ? lower : 'opencode'
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

export type SubmitJobService = {
  accept(submission: JobSubmission): Promise<{
    submissionId: string
    jobId: string
    acceptedAt: string
  }>
}

export function createSubmitJobService(deps: {
  db: Database.Database
  outbox: ExecutionOutbox
}): SubmitJobService {
  const dedup = new JobSubmissionDedup(deps.db)

  return {
    async accept(submission) {
      const submissionHash = hashSubmission(submission)
      const bySubmissionId = dedup.checkSubmissionId(submission.submissionId)
      if (bySubmissionId) {
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
      for (const milestone of submission.executionTree.milestones) {
        for (const slice of milestone.slices) {
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
            JSON.stringify(submission.draftSnapshot),
            JSON.stringify(submission.executionProfile),
            JSON.stringify(submission.executionSettings),
            JSON.stringify(submission.referenceManifest),
            JSON.stringify(submission.executionTree),
            settingsHash,
            contentHash,
            now
          )

        let milestoneSort = 0
        for (const milestone of submission.executionTree.milestones) {
          const milestoneId = newId('jm')
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
            const sliceId = newId('js')
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
                    milestone_id, slice_id, kind, sort_order, title, description,
                    context_markdown, ability_code, provider_code, success_criteria,
                    can_run_in_parallel, state, state_revision, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
                )
                .run(
                  workId,
                  jobId,
                  generation,
                  task.id,
                  milestoneId,
                  sliceId,
                  taskSort,
                  task.title,
                  task.description,
                  task.contextMarkdown,
                  task.abilityCode,
                  normalizeProvider(task.coreCode),
                  task.successCriteria,
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
          { jobId, submissionId: submission.submissionId },
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
