export interface ArtifactMeta {
  readonly id: string
  readonly kind: string
  readonly contentHash?: string
  readonly createdAtMs?: number
  /** When true, write did not finish; must not be treated as durable. */
  readonly incomplete?: boolean
}

export interface ArtifactWriteHandle {
  readonly id: string
  writeChunk(chunk: Uint8Array | string): Promise<void>
  commit(meta?: Partial<ArtifactMeta>): Promise<ArtifactMeta>
  abort(): Promise<void>
}

export interface ArtifactStore {
  putMeta(meta: ArtifactMeta): Promise<void>
  getMeta(id: string): Promise<ArtifactMeta | undefined>
  beginWrite(id: string, kind: string): Promise<ArtifactWriteHandle>
}
