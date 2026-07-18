import { createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import type { DbExecutor } from './db-executor'
import type { EvidenceRepository as EvidenceRepositoryPort } from '../../../application/ports/evidence-repository'
import { controlEvidenceBlobs } from './schema'

export class SqliteEvidenceRepository implements EvidenceRepositoryPort {
  constructor(private readonly db: DbExecutor) {}

  putImmutable(evidence: readonly string[], createdAtMs: number): string {
    const content = JSON.stringify(evidence)
    const hash = createHash('sha256').update(content).digest('hex')

    const existing = this.getByHash(hash)
    if (existing !== null) return hash

    this.db
      .insert(controlEvidenceBlobs)
      .values({
        hash,
        contentJson: content,
        bytes: content.length,
        createdAtMs
      })
      .run()

    return hash
  }

  putVerdictBlob(verdict: unknown, createdAtMs: number): string {
    const content = JSON.stringify(verdict)
    const hash = createHash('sha256').update(content).digest('hex')
    const existing = this.getByHash(hash)
    if (existing !== null) return hash

    this.db
      .insert(controlEvidenceBlobs)
      .values({
        hash,
        contentJson: content,
        bytes: content.length,
        createdAtMs
      })
      .run()

    return hash
  }

  getByHash(hash: string): string | null {
    const result = this.db
      .select({ contentJson: controlEvidenceBlobs.contentJson })
      .from(controlEvidenceBlobs)
      .where(eq(controlEvidenceBlobs.hash, hash))
      .get()

    return result?.contentJson ?? null
  }

  verifyHash(hash: string, evidence: readonly string[]): boolean {
    const content = JSON.stringify(evidence)
    const computedHash = createHash('sha256').update(content).digest('hex')
    return computedHash === hash
  }
}
