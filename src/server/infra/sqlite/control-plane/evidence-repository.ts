import { createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './job-repository'
import type { EvidenceStore } from '../../../application/ports/evidence-store'
import { controlEvidenceBlobs } from './schema'

export class EvidenceRepository implements EvidenceStore {
  constructor(private readonly db: ControlPlaneDatabase) {}

  putImmutable(evidence: readonly string[]): string {
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
        createdAtMs: Date.now()
      })
      .run()

    return hash
  }

  putVerdictBlob(verdict: unknown): string {
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
        createdAtMs: Date.now()
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
