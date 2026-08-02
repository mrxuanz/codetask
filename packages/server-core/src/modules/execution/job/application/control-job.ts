import type Database from 'better-sqlite3'
import type { JobCommandBody, JobCommandResult } from '@codetask/contracts'
import type { Actor } from '../../shared.ts'
import {
  ExecutionConflictError,
  ExecutionForbiddenError,
  ExecutionValidationError,
  newId,
  nowMs,
  stableHash
} from '../../shared.ts'
import { JobRepository } from '../infrastructure/job-repository.ts'
import { QueueRepository } from '../../queue/infrastructure/queue-repository.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'
import { normalizeProvider } from './submit-job.ts'
import type { WakeSchedulerFn } from '../../queue/application/wake-scheduler.ts'

/** Recovery reasons that require explicit replay authorization before continue. */
function recoveryNeedsReplayAuthorization(recoveryReason: string | null): boolean {
  return (
    recoveryReason === 'uncertain_provider_outcome' ||
    recoveryReason === 'restart_interrupted' ||
    recoveryReason === 'migration_ambiguous'
  )
}

export class ControlJobService {
  constructor(
    private readonly db: Database.Database,
    private readonly jobs: JobRepository,
    private readonly queue: QueueRepository,
    private readonly outbox: ExecutionOutbox,
    private readonly wakeScheduler: WakeSchedulerFn
  ) {}

  private assertOwner(actor: Actor, actorId: string): void {
    if (actor.userId !== actorId) throw new ExecutionForbiddenError()
  }

  private withReceipt(
    actor: Actor,
    jobId: string,
    command: JobCommandResult extends never ? never : 'pause' | 'continue' | 'cancel' | 'restart',
    body: JobCommandBody,
    fn: () => JobCommandResult
  ): JobCommandResult {
    const requestHash = stableHash(JSON.stringify({ jobId, command, body }))
    const existing = this.jobs.getCommandReceipt(actor.userId, body.idempotencyKey)
    if (existing) {
      const parsed = JSON.parse(existing.responseJson) as JobCommandResult
      if (parsed.jobId === jobId) return parsed
      throw new ExecutionConflictError('Idempotency key reused for different command')
    }
    const result = fn()
    this.jobs.saveCommandReceipt({
      actorId: actor.userId,
      idempotencyKey: body.idempotencyKey,
      jobId,
      command,
      requestHash,
      responseJson: JSON.stringify(result),
      createdAt: nowMs()
    })
    return result
  }

  pause(actor: Actor, jobId: string, body: JobCommandBody): JobCommandResult {
    return this.withReceipt(actor, jobId, 'pause', body, () => {
      const job = this.jobs.requireById(jobId)
      this.assertOwner(actor, job.actorId)
      if (job.state !== 'running') {
        throw new ExecutionValidationError('Job is not running')
      }
      const updated = this.jobs.casUpdateState({
        jobId,
        expectedRevision: body.expectedRevision,
        next: {
          state: 'pausing',
          controlIntent: 'pause',
          updatedAt: nowMs()
        }
      })
      this.outbox.enqueue(jobId, 'job.changed', { jobId, state: updated.state })
      return {
        jobId,
        state: updated.state,
        stateRevision: updated.stateRevision,
        accepted: true
      }
    })
  }

  continue(actor: Actor, jobId: string, body: JobCommandBody): JobCommandResult {
    return this.withReceipt(actor, jobId, 'continue', body, () => {
      const job = this.jobs.requireById(jobId)
      this.assertOwner(actor, job.actorId)
      if (job.state !== 'paused' && job.state !== 'failed') {
        throw new ExecutionValidationError('Job cannot be continued')
      }
      if (recoveryNeedsReplayAuthorization(job.recoveryReason) && body.authorizeReplay !== true) {
        throw new ExecutionValidationError(
          'Replay authorization required for jobs with uncertain provider outcome'
        )
      }
      const now = nowMs()
      const sequence = this.queue.nextSequence()
      const tx = this.db.transaction(() => {
        if (body.authorizeReplay === true) {
          this.db
            .prepare(
              `UPDATE work_attempts SET replay_authorized_at = ?
               WHERE job_id = ? AND status = 'interrupted'`
            )
            .run(now, jobId)
        }
        const updated = this.jobs.casUpdateState({
          jobId,
          expectedRevision: body.expectedRevision,
          next: {
            state: 'queued',
            controlIntent: 'none',
            recoveryReason: null,
            queuedAt: now,
            updatedAt: now
          }
        })
        this.db
          .prepare(
            `INSERT OR REPLACE INTO execution_queue_entries (
              job_id, generation, status, priority, sequence, enqueued_at
            ) VALUES (?, ?, 'queued', 0, ?, ?)`
          )
          .run(jobId, updated.executionGeneration, sequence, now)
        this.outbox.enqueue(jobId, 'job.queue.changed', { jobId }, this.db)
        return updated
      })
      const updated = tx()
      this.wakeScheduler()
      return {
        jobId,
        state: updated.state,
        stateRevision: updated.stateRevision,
        accepted: true
      }
    })
  }

  cancel(actor: Actor, jobId: string, body: JobCommandBody): JobCommandResult {
    return this.withReceipt(actor, jobId, 'cancel', body, () => {
      const job = this.jobs.requireById(jobId)
      this.assertOwner(actor, job.actorId)
      const now = nowMs()
      let nextState = job.state
      if (job.state === 'queued' || job.state === 'paused') {
        nextState = 'cancelled'
      } else if (job.state === 'running' || job.state === 'pausing') {
        nextState = 'cancelling'
      } else {
        throw new ExecutionValidationError('Job cannot be cancelled')
      }
      const updated = this.jobs.casUpdateState({
        jobId,
        expectedRevision: body.expectedRevision,
        next: {
          state: nextState,
          controlIntent: 'cancel',
          terminalAt: nextState === 'cancelled' ? now : job.terminalAt,
          updatedAt: now
        }
      })
      this.outbox.enqueue(jobId, 'job.changed', { jobId, state: updated.state })
      return {
        jobId,
        state: updated.state,
        stateRevision: updated.stateRevision,
        accepted: true
      }
    })
  }

  restart(actor: Actor, jobId: string, body: JobCommandBody): JobCommandResult {
    return this.withReceipt(actor, jobId, 'restart', body, () => {
      const job = this.jobs.requireById(jobId)
      this.assertOwner(actor, job.actorId)
      if (job.state !== 'failed' && job.state !== 'cancelled' && job.state !== 'paused') {
        throw new ExecutionValidationError('Job cannot be restarted')
      }
      const now = nowMs()
      const nextGeneration = job.executionGeneration + 1
      const sequence = this.queue.nextSequence()

      const tx = this.db.transaction(() => {
        const snapshot = this.db
          .prepare(`SELECT execution_tree_json FROM job_snapshots WHERE job_id = ?`)
          .get(jobId) as { execution_tree_json: string }
        const tree = JSON.parse(snapshot.execution_tree_json)

        const updated = this.jobs.casUpdateState({
          jobId,
          expectedRevision: body.expectedRevision,
          next: {
            state: 'queued',
            controlIntent: 'none',
            executionGeneration: nextGeneration,
            currentRunId: null,
            recoveryReason: null,
            queuedAt: now,
            startedAt: null,
            terminalAt: null,
            updatedAt: now
          }
        })

        // Re-materialize work from immutable snapshot for new generation
        this.rebuildGeneration(jobId, nextGeneration, tree, now)

        this.db
          .prepare(
            `INSERT INTO execution_queue_entries (
              job_id, generation, status, priority, sequence, enqueued_at
            ) VALUES (?, ?, 'queued', 0, ?, ?)`
          )
          .run(jobId, nextGeneration, sequence, now)

        this.outbox.enqueue(jobId, 'job.queue.changed', { jobId, generation: nextGeneration }, this.db)
        return updated
      })

      const updated = tx()
      this.wakeScheduler()
      return {
        jobId,
        state: updated.state,
        stateRevision: updated.stateRevision,
        accepted: true
      }
    })
  }

  private rebuildGeneration(
    jobId: string,
    generation: number,
    tree: {
      milestones: Array<{
        id: string
        title: string
        description: string
        successCriteria: string
        slices: Array<{
          id: string
          title: string
          description: string
          successCriteria: string
          tasks: Array<{
            id: string
            title: string
            description: string
            contextMarkdown: string
            abilityCode: string
            coreCode: string
            successCriteria: string
            canRunInParallel: boolean
            referenceIds: string[]
            dependsOnTaskIds: string[]
          }>
        }>
      }>
    },
    now: number
  ): void {
    const taskIdToWorkId = new Map<string, string>()
    for (const milestone of tree.milestones) {
      for (const slice of milestone.slices) {
        for (const task of slice.tasks) {
          taskIdToWorkId.set(task.id, generation === 0 ? `work_${task.id}` : newId('work'))
        }
      }
    }

    let milestoneSort = 0
    for (const milestone of tree.milestones) {
      const milestoneId = newId('jm')
      this.db
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
        this.db
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
        let previousWorkId: string | null = null
        for (const task of slice.tasks) {
          const workId = taskIdToWorkId.get(task.id)!
          this.db
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

          for (const depTaskId of task.dependsOnTaskIds) {
            const dependsOnWorkId = taskIdToWorkId.get(depTaskId)!
            this.db
              .prepare(
                `INSERT INTO job_work_dependencies (
                  job_id, generation, from_work_id, depends_on_work_id, reason
                ) VALUES (?, ?, ?, ?, 'planner')`
              )
              .run(jobId, generation, workId, dependsOnWorkId)
          }
          if (!task.canRunInParallel && task.dependsOnTaskIds.length === 0 && previousWorkId) {
            this.db
              .prepare(
                `INSERT INTO job_work_dependencies (
                  job_id, generation, from_work_id, depends_on_work_id, reason
                ) VALUES (?, ?, ?, ?, 'implicit-order')`
              )
              .run(jobId, generation, workId, previousWorkId)
          }

          for (const refId of task.referenceIds) {
            this.db
              .prepare(
                `INSERT INTO job_work_references (job_id, generation, work_id, reference_id)
                 VALUES (?, ?, ?, ?)`
              )
              .run(jobId, generation, workId, refId)
          }

          previousWorkId = workId
          taskSort += 1
        }
      }
    }
  }
}
