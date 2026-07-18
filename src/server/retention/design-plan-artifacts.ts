import { createHash } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { and, desc, eq, lte, ne } from 'drizzle-orm'
import type { SavedJobPlan } from '../planner/plan-types'
import { buildPlanSummary } from '@shared/plan-mutations'
import type { AppDatabase } from '../db'
import { designPlanRevisions } from '../db/schema'
import { signalArtifactExpiry } from './expiry-signal'

const MAX_EDITING_REVISIONS = 3

export class DesignPlanRevisionConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly planRevision: number
  ) {
    super(`Design plan revision ${jobId}@${planRevision} already exists with different content`)
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  )
}

function canonicalJson(plan: SavedJobPlan): string {
  return JSON.stringify(canonicalize(plan))
}

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function designPlanRevisionContentPath(jobId: string, planRevision: number): string {
  return `sqlite:${jobId}:${planRevision}`
}

export interface DesignPlanRevisionMetadata {
  artifactId: string
  summaryJson: string
  contentPath: string
  contentHash: string
}

export function putDesignPlanRevisionInTx(
  db: AppDatabase,
  input: {
    jobId: string
    planRevision: number
    plan: SavedJobPlan
    createdAt?: number
    expiresAt?: number | null
    maxRevisions?: number
  }
): DesignPlanRevisionMetadata {
  const raw = canonicalJson(input.plan)
  const contentHash = hashContent(raw)
  const compressed = gzipSync(raw)
  const existing = db
    .select({ contentHash: designPlanRevisions.contentHash })
    .from(designPlanRevisions)
    .where(
      and(
        eq(designPlanRevisions.jobId, input.jobId),
        eq(designPlanRevisions.planRevision, input.planRevision)
      )
    )
    .limit(1)
    .all()[0]

  if (existing && existing.contentHash !== contentHash) {
    throw new DesignPlanRevisionConflictError(input.jobId, input.planRevision)
  }
  if (!existing) {
    db.insert(designPlanRevisions)
      .values({
        jobId: input.jobId,
        planRevision: input.planRevision,
        contentGzip: compressed,
        contentHash,
        rawByteSize: Buffer.byteLength(raw, 'utf8'),
        gzipByteSize: compressed.byteLength,
        createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
        expiresAt: input.expiresAt ?? null
      })
      .run()
    signalArtifactExpiry(input.expiresAt)
  }

  const revisions = db
    .select({ planRevision: designPlanRevisions.planRevision })
    .from(designPlanRevisions)
    .where(eq(designPlanRevisions.jobId, input.jobId))
    .orderBy(desc(designPlanRevisions.planRevision))
    .all()
  for (const stale of revisions.slice(input.maxRevisions ?? MAX_EDITING_REVISIONS)) {
    db.delete(designPlanRevisions)
      .where(
        and(
          eq(designPlanRevisions.jobId, input.jobId),
          eq(designPlanRevisions.planRevision, stale.planRevision)
        )
      )
      .run()
  }

  const artifactId = `drev-${input.jobId}-${input.planRevision}`
  return {
    artifactId,
    contentHash,
    contentPath: designPlanRevisionContentPath(input.jobId, input.planRevision),
    summaryJson: JSON.stringify({
      artifactId,
      planRevision: input.planRevision,
      contentHash,
      byteSize: Buffer.byteLength(raw, 'utf8'),
      ...buildPlanSummary(input.plan)
    })
  }
}

export function readDesignPlanRevision(
  db: AppDatabase,
  jobId: string,
  planRevision: number
): SavedJobPlan | null {
  const row = db
    .select({ contentGzip: designPlanRevisions.contentGzip })
    .from(designPlanRevisions)
    .where(
      and(eq(designPlanRevisions.jobId, jobId), eq(designPlanRevisions.planRevision, planRevision))
    )
    .limit(1)
    .all()[0]
  if (!row) return null
  try {
    return JSON.parse(gunzipSync(row.contentGzip).toString('utf8')) as SavedJobPlan
  } catch {
    return null
  }
}

export function finalizeDesignPlanRevisions(
  db: AppDatabase,
  jobId: string,
  currentRevision: number,
  expiresAt: number | null
): void {
  db.transaction((tx) => {
    tx.delete(designPlanRevisions)
      .where(
        and(
          eq(designPlanRevisions.jobId, jobId),
          ne(designPlanRevisions.planRevision, currentRevision)
        )
      )
      .run()
    tx.update(designPlanRevisions)
      .set({ expiresAt })
      .where(
        and(
          eq(designPlanRevisions.jobId, jobId),
          eq(designPlanRevisions.planRevision, currentRevision)
        )
      )
      .run()
  })
  signalArtifactExpiry(expiresAt)
}

export function deleteExpiredDesignPlanRevisions(
  db: AppDatabase,
  cutoff = Math.floor(Date.now() / 1000)
): { deleted: number; deletedBytes: number } {
  const rows = db
    .select({
      jobId: designPlanRevisions.jobId,
      planRevision: designPlanRevisions.planRevision,
      gzipByteSize: designPlanRevisions.gzipByteSize
    })
    .from(designPlanRevisions)
    .where(lte(designPlanRevisions.expiresAt, cutoff))
    .limit(250)
    .all()
  if (rows.length > 0) {
    db.transaction((tx) => {
      for (const row of rows) {
        tx.delete(designPlanRevisions)
          .where(
            and(
              eq(designPlanRevisions.jobId, row.jobId),
              eq(designPlanRevisions.planRevision, row.planRevision)
            )
          )
          .run()
      }
    })
  }
  return {
    deleted: rows.length,
    deletedBytes: rows.reduce((total, row) => total + row.gzipByteSize, 0)
  }
}
