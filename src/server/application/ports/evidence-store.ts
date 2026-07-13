export interface EvidenceStore {
  putImmutable(evidence: readonly string[]): string
  putVerdictBlob(verdict: unknown): string
  getByHash(hash: string): string | null
}
