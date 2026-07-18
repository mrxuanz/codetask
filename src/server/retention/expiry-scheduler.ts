import type Database from 'better-sqlite3'
import type { AppContext } from '../context'
import { deleteExpiredArtifacts } from './artifacts'
import { deleteExpiredDesignPlanRevisions } from './design-plan-artifacts'
import { deleteExpiredMessageArtifacts } from './message-artifacts'
import { bindArtifactExpirySignal } from './expiry-signal'

const MAX_SLEEP_MS = 60 * 60_000

function sqliteClient(ctx: AppContext): Database.Database {
  const client = (ctx.db as typeof ctx.db & { $client?: Database.Database }).$client
  if (!client) throw new Error('Artifact expiry scheduler requires direct SQLite access')
  return client
}

export class ArtifactExpiryScheduler {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private scheduledDeadline: number | null = null
  private running = false

  constructor(
    private readonly ctx: AppContext,
    private readonly now: () => number = () => Date.now()
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    bindArtifactExpirySignal((expiresAt) => this.notifyEarlierDeadline(expiresAt))
    void this.catchUpAndSchedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.scheduledDeadline = null
    bindArtifactExpirySignal(null)
  }

  notifyEarlierDeadline(expiresAt: number): void {
    if (this.stopped) return
    if (this.scheduledDeadline == null || expiresAt < this.scheduledDeadline) {
      this.schedule(expiresAt)
    }
  }

  async runDueNow(): Promise<{ deletedRows: number; deletedBytes: number }> {
    const cutoff = Math.floor(this.now() / 1000)
    const [jobs, messages] = await Promise.all([
      deleteExpiredArtifacts(this.ctx.db, this.ctx.dataDir, cutoff),
      deleteExpiredMessageArtifacts(this.ctx.db, this.ctx.dataDir, cutoff)
    ])
    const designs = deleteExpiredDesignPlanRevisions(this.ctx.db, cutoff)
    return {
      deletedRows: jobs.deleted + messages.deleted + designs.deleted,
      deletedBytes: jobs.deletedBytes + messages.deletedBytes + designs.deletedBytes
    }
  }

  private nextDeadline(): number | null {
    const row = sqliteClient(this.ctx)
      .prepare(
        `SELECT MIN(expires_at) AS deadline
         FROM (
           SELECT expires_at FROM job_artifacts WHERE expires_at IS NOT NULL
           UNION ALL
           SELECT expires_at FROM message_artifacts WHERE expires_at IS NOT NULL
           UNION ALL
           SELECT expires_at FROM design_plan_revisions WHERE expires_at IS NOT NULL
         )`
      )
      .get() as { deadline: number | null } | undefined
    return row?.deadline ?? null
  }

  private async catchUpAndSchedule(): Promise<void> {
    if (this.stopped || this.running) return
    this.running = true
    try {
      await this.runDueNow()
    } catch (error) {
      console.warn('[retention] artifact expiry pass failed', error)
    } finally {
      this.running = false
    }
    if (!this.stopped) this.schedule(this.nextDeadline())
  }

  private schedule(deadline: number | null): void {
    if (this.timer) clearTimeout(this.timer)
    this.scheduledDeadline = deadline
    const deadlineDelay =
      deadline == null ? MAX_SLEEP_MS : Math.max(0, deadline * 1000 - this.now())
    const delay = Math.min(MAX_SLEEP_MS, deadlineDelay)
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.scheduledDeadline = null
        void this.catchUpAndSchedule()
      },
      Math.max(1, delay)
    )
    this.timer.unref?.()
  }
}

let scheduler: ArtifactExpiryScheduler | null = null

export function startArtifactExpiryScheduler(ctx: AppContext): void {
  if (scheduler) return
  scheduler = new ArtifactExpiryScheduler(ctx)
  scheduler.start()
}

export function stopArtifactExpiryScheduler(): void {
  scheduler?.stop()
  scheduler = null
}
