export interface MigrationCounts {
  readonly projects: number
  readonly threads: number
  readonly drafts: number
  readonly plans: number
  readonly jobs: number
  readonly tasks: number
}

export interface MigrationReport {
  readonly counts: MigrationCounts
  /** SHA-256 hex of a stable summary of migrated row ids + counts. */
  readonly hash: string
  readonly sourcePath: string
  readonly targetPath: string
}

export interface MigrateLegacyToCoreInput {
  readonly sourcePath: string
  readonly targetPath: string
}

export class UnmappableLegacyRowError extends Error {
  readonly code = 'legacy.unmappable' as const

  constructor(
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'UnmappableLegacyRowError'
  }
}
