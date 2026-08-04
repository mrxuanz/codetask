export type JobReferenceManifestDto = {
  jobId: string
  threadId: string
  frozenAt: string
  ignoredReferenceIds: string[]
  references: Array<{
    id: string
    name: string
    kind: 'image' | 'file' | 'directory'
    mimeType: string
    description: string
    relativePath?: string | undefined
    requiresDescription: boolean
    assetUrl: string
    excludedFromCoverage?: boolean | undefined
  }>
}
