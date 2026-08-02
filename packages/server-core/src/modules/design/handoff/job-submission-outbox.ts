import type { JobSubmissionPort } from '../planning/application/planning-application.ts'
import type Database from 'better-sqlite3'
import type { JobSubmission } from '@codetask/contracts'

export class JobSubmissionOutbox {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: Database.Database,
    private readonly jobSubmission: JobSubmissionPort
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
    const rows = this.db
      .prepare(
        `SELECT submission_id, payload_json FROM job_handoffs
         WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20`
      )
      .all() as Array<{ submission_id: string; payload_json: string }>

    let accepted = 0
    for (const row of rows) {
      try {
        const submission = JSON.parse(row.payload_json) as JobSubmission
        const result = await this.jobSubmission.accept(submission)
        this.db
          .prepare(
            `UPDATE job_handoffs SET status = 'accepted', job_id = ?, accepted_at = ?, attempts = attempts + 1
             WHERE submission_id = ? AND status = 'pending'`
          )
          .run(result.jobId, Date.now(), row.submission_id)
        this.db
          .prepare(
            `UPDATE planning_sessions SET status = 'published', published_job_id = ?, published_at = ?, updated_at = ?
             WHERE id = ? AND status = 'publishing'`
          )
          .run(result.jobId, Date.now(), Date.now(), submission.source.planningSessionId)
        accepted += 1
      } catch (error) {
        this.db
          .prepare(
            `UPDATE job_handoffs SET attempts = attempts + 1, last_error_json = ?
             WHERE submission_id = ?`
          )
          .run(
            JSON.stringify({
              message: error instanceof Error ? error.message : String(error)
            }),
            row.submission_id
          )
      }
    }
    return accepted
  }
}
