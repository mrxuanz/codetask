import type { JobSubmissionPort } from '../planning/application/planning-application.ts'
import type Database from 'better-sqlite3'
import type { JobSubmission } from '@codetask/contracts'

export class JobSubmissionOutbox {
  private timer: NodeJS.Timeout | null = null
  private readonly maxAttempts = 5

  constructor(
    private readonly db: Database.Database,
    private readonly jobSubmission: JobSubmissionPort,
    private readonly publishEvent?: (
      sessionId: string,
      event: 'planning.published' | 'planning.failed',
      payload: Record<string, unknown>
    ) => void
  ) {}

  asPort(): JobSubmissionPort {
    return this.jobSubmission
  }

  start(intervalMs = 2_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.drainOnce()
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async drainOnce(): Promise<number> {
    const now = Date.now()
    const rows = this.db
      .prepare(
        `SELECT submission_id, planning_session_id, payload_json, attempts FROM job_handoffs
         WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT 20`
      )
      .all(now) as Array<{
      submission_id: string
      planning_session_id: string
      payload_json: string
      attempts: number
    }>

    let accepted = 0
    for (const row of rows) {
      let parsedSubmission: JobSubmission | null = null
      try {
        const submission = JSON.parse(row.payload_json) as JobSubmission
        parsedSubmission = submission
        const result = await this.jobSubmission.accept(submission)
        const acceptedAt = Date.now()
        const complete = this.db.transaction(() => {
          const handoff = this.db
            .prepare(
              `UPDATE job_handoffs
               SET status = 'accepted', job_id = ?, accepted_at = ?, attempts = attempts + 1,
                   next_attempt_at = NULL, last_error_json = NULL, payload_json = ?
               WHERE submission_id = ? AND status = 'pending'`
            )
            .run(
              result.jobId,
              acceptedAt,
              JSON.stringify({
                submissionId: submission.submissionId,
                actorId: submission.actorId,
                source: { planningSessionId: submission.source.planningSessionId }
              }),
              row.submission_id
            )
          if (handoff.changes !== 1) return false
          this.db
            .prepare(
              `UPDATE planning_sessions
               SET status = 'published', published_job_id = ?, published_at = ?, updated_at = ?,
                   last_error_json = NULL
               WHERE id = ? AND status = 'publishing'`
            )
            .run(result.jobId, acceptedAt, acceptedAt, row.planning_session_id)
          return true
        })
        if (complete()) {
          accepted += 1
          this.publishEvent?.(row.planning_session_id, 'planning.published', {
            jobId: result.jobId
          })
        }
      } catch (error) {
        const attempts = row.attempts + 1
        const message = error instanceof Error ? error.message : String(error)
        const errorJson = JSON.stringify({ message })
        if (attempts >= this.maxAttempts) {
          const failedAt = Date.now()
          const compactPayload = JSON.stringify({
            submissionId: parsedSubmission?.submissionId ?? row.submission_id,
            actorId: parsedSubmission?.actorId ?? '',
            source: {
              planningSessionId:
                parsedSubmission?.source.planningSessionId ?? row.planning_session_id
            }
          })
          const fail = this.db.transaction(() => {
            const handoff = this.db
              .prepare(
                `UPDATE job_handoffs
                 SET status = 'failed', attempts = ?, last_error_json = ?,
                     next_attempt_at = NULL, failed_at = ?, payload_json = ?
                 WHERE submission_id = ? AND status = 'pending'`
              )
              .run(attempts, errorJson, failedAt, compactPayload, row.submission_id)
            if (handoff.changes !== 1) return false
            this.db
              .prepare(
                `UPDATE planning_sessions
                 SET status = 'failed', last_error_json = ?, updated_at = ?
                 WHERE id = ? AND status = 'publishing'`
              )
              .run(errorJson, failedAt, row.planning_session_id)
            return true
          })
          if (fail()) {
            this.publishEvent?.(row.planning_session_id, 'planning.failed', { message })
          }
        } else {
          const delayMs = Math.min(2_000 * 2 ** Math.max(0, attempts - 1), 60_000)
          this.db
            .prepare(
              `UPDATE job_handoffs
               SET attempts = ?, last_error_json = ?, next_attempt_at = ?
               WHERE submission_id = ? AND status = 'pending'`
            )
            .run(attempts, errorJson, Date.now() + delayMs, row.submission_id)
        }
      }
    }
    return accepted
  }
}
