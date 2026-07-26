import type { ApplicationDependencies } from '../core/application/dependencies'

export type CreateApplicationOptions = {
  readonly mode?: 'memory' | 'sqlite'
  /** Required when mode==='sqlite' */
  readonly sqlitePath?: string
}

export type ApplicationHandle = ApplicationDependencies & {
  readonly kind: 'memory' | 'sqlite'
  /** Close sqlite if opened; no-op for memory */
  close(): void
}
