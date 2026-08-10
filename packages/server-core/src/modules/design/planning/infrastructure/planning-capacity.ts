import type Database from 'better-sqlite3'
import type { PlanningCapacityPort } from '../application/planning-application.ts'
import { newId, nowMs } from '../../shared.ts'

/** Design-owned planner capacity — never uses Execution Pool / workload slots. */
export class SqlitePlanningCapacity implements PlanningCapacityPort {
  constructor(
    private readonly db: Database.Database,
    private readonly maxPerPool = 1,
    private readonly leaseTtlMs = 30_000
  ) {}

  async acquire(input: {
    planningSessionId: string
    pool: string
  }): Promise<{ leaseId: string } | null> {
    const acquire = this.db.transaction((): { leaseId: string } | null => {
      const now = nowMs()
      this.db
        .prepare(
          `UPDATE planning_capacity_leases SET released_at = ?
           WHERE released_at IS NULL AND acquired_at < ?`
        )
        .run(now, now - this.leaseTtlMs)
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM planning_capacity_leases
           WHERE pool = ? AND released_at IS NULL`
        )
        .get(input.pool) as { count: number }
      if (active.count >= this.maxPerPool) return null

      const leaseId = newId('please')
      this.db
        .prepare(
          `INSERT INTO planning_capacity_leases (id, planning_session_id, pool, acquired_at, released_at)
           VALUES (?, ?, ?, ?, NULL)`
        )
        .run(leaseId, input.planningSessionId, input.pool, now)
      return { leaseId }
    })
    try {
      return acquire.immediate()
    } catch {
      return null
    }
  }

  async heartbeat(leaseId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE planning_capacity_leases SET acquired_at = ? WHERE id = ? AND released_at IS NULL`
      )
      .run(nowMs(), leaseId)
  }

  async release(leaseId: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE planning_capacity_leases SET released_at = ? WHERE id = ? AND released_at IS NULL`
      )
      .run(nowMs(), leaseId)
  }
}
