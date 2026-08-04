import type Database from 'better-sqlite3'

export class VerificationRepository {
  constructor(private readonly db: Database.Database) {}

  getSliceVerificationState(jobId: string, generation: number, sliceId: string): string {
    const row = this.db
      .prepare(
        `SELECT verification_state FROM job_slices
         WHERE job_id = ? AND generation = ? AND id = ?`
      )
      .get(jobId, generation, sliceId) as { verification_state: string } | undefined
    return row?.verification_state ?? 'pending'
  }

  getMilestoneState(jobId: string, generation: number, milestoneId: string): string {
    const row = this.db
      .prepare(`SELECT state FROM job_milestones WHERE job_id = ? AND generation = ? AND id = ?`)
      .get(jobId, generation, milestoneId) as { state: string } | undefined
    return row?.state ?? 'pending'
  }

  listSliceIds(jobId: string, generation: number, milestoneId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM job_slices WHERE job_id = ? AND generation = ? AND milestone_id = ? ORDER BY sort_order`
      )
      .all(jobId, generation, milestoneId) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  listMilestoneIds(jobId: string, generation: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM job_milestones WHERE job_id = ? AND generation = ? ORDER BY sort_order`
      )
      .all(jobId, generation) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  listVerifications(jobId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT vr.*, va.scope_type, va.scope_id, va.attempt_number
         FROM verification_results vr
         JOIN verification_attempts va ON va.id = vr.verification_attempt_id
         WHERE va.job_id = ?
         ORDER BY vr.created_at DESC`
      )
      .all(jobId) as Array<Record<string, unknown>>
  }

  updateSliceVerification(
    jobId: string,
    generation: number,
    sliceId: string,
    verificationState: string,
    sliceState: string
  ): void {
    this.db
      .prepare(
        `UPDATE job_slices SET verification_state = ?, state = ?
         WHERE job_id = ? AND generation = ? AND id = ?`
      )
      .run(verificationState, sliceState, jobId, generation, sliceId)
  }

  updateMilestoneState(
    jobId: string,
    generation: number,
    milestoneId: string,
    state: string
  ): void {
    this.db
      .prepare(`UPDATE job_milestones SET state = ? WHERE job_id = ? AND generation = ? AND id = ?`)
      .run(state, jobId, generation, milestoneId)
  }
}
