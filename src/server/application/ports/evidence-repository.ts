export interface EvidenceRepository {
  putImmutable(evidence: readonly string[], createdAtMs: number): string
  putVerdictBlob(verdict: unknown, createdAtMs: number): string
  getByHash(hash: string): string | null
}
