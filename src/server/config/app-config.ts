import { DEFAULT_SANDBOX_TURN_TIMEOUT_MS } from '../sandbox/session-state'
import {
  createProvidersConfig,
  type ProvidersConfig,
  type ProvidersConfigOverrides
} from '../../shared/providers/settings'
import {
  DEFAULT_RETENTION_SETTINGS,
  type RetentionSettings
} from '../../shared/contracts/retention.ts'
import {
  DEFAULT_RUNTIME_FEATURES,
  type DebugRuntimeFeatures,
  type SandboxRuntimeFeatures
} from './runtime-features'

export interface HttpConfig {
  readonly requestTimeoutMs: number
  readonly maxSseClientsPerUser: number
  readonly maxConcurrentTurnsPerUser: number
}

export interface TurnConfig {
  readonly maxRetries: number
  readonly absoluteMaxRetries: number
  readonly progressWindowMs: number
  readonly stalledMs: number
  readonly noFirstSignalMs: number | null
  readonly longRunningToolCapMs: number
}

export interface RunLifecycleConfig {
  readonly cancelGraceMs: number
  readonly killGraceMs: number
}

export interface ExecutionConfig {
  readonly workloadPoolCapacity: number
  readonly workloadLeaseTtlSec: number
  readonly runLifecycle: RunLifecycleConfig
}

export interface SandboxConfig extends SandboxRuntimeFeatures {}

export interface DebugConfig extends DebugRuntimeFeatures {}

export interface AppConfig {
  readonly http: HttpConfig
  readonly turn: TurnConfig
  readonly execution: ExecutionConfig
  readonly providers: ProvidersConfig
  readonly sandbox: SandboxConfig
  readonly debug: DebugConfig
  /** Deploy/code retention policy — not a user Settings namespace (05). */
  readonly retention: RetentionSettings
}

export interface AppConfigOverrides {
  http?: Partial<HttpConfig>
  turn?: Partial<TurnConfig>
  execution?: Partial<Omit<ExecutionConfig, 'runLifecycle'>> & {
    runLifecycle?: Partial<RunLifecycleConfig>
  }
  providers?: ProvidersConfigOverrides
  sandbox?: Partial<SandboxConfig>
  debug?: Partial<DebugConfig>
  retention?: Partial<RetentionSettings>
}

/**
 * CodeTask-owned runtime defaults live here instead of being inferred from
 * process-wide environment variables at arbitrary call sites.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  http: {
    requestTimeoutMs: 30_000,
    maxSseClientsPerUser: 8,
    maxConcurrentTurnsPerUser: 2
  },
  turn: {
    maxRetries: 3,
    absoluteMaxRetries: 5,
    progressWindowMs: 5 * 60_000,
    stalledMs: 60 * 60_000,
    noFirstSignalMs: null,
    longRunningToolCapMs: DEFAULT_SANDBOX_TURN_TIMEOUT_MS
  },
  execution: {
    workloadPoolCapacity: 1,
    workloadLeaseTtlSec: 90 * 60,
    runLifecycle: {
      cancelGraceMs: 10_000,
      killGraceMs: 5_000
    }
  },
  providers: createProvidersConfig(),
  sandbox: { ...DEFAULT_RUNTIME_FEATURES.sandbox },
  debug: { ...DEFAULT_RUNTIME_FEATURES.debug },
  retention: { ...DEFAULT_RETENTION_SETTINGS }
}

export function createAppConfig(overrides: AppConfigOverrides = {}): AppConfig {
  return {
    http: {
      ...DEFAULT_APP_CONFIG.http,
      ...overrides.http
    },
    turn: {
      ...DEFAULT_APP_CONFIG.turn,
      ...overrides.turn
    },
    execution: {
      ...DEFAULT_APP_CONFIG.execution,
      ...overrides.execution,
      runLifecycle: {
        ...DEFAULT_APP_CONFIG.execution.runLifecycle,
        ...overrides.execution?.runLifecycle
      }
    },
    providers: createProvidersConfig(overrides.providers),
    sandbox: {
      ...DEFAULT_APP_CONFIG.sandbox,
      ...overrides.sandbox
    },
    debug: {
      ...DEFAULT_APP_CONFIG.debug,
      ...overrides.debug
    },
    retention: {
      ...DEFAULT_APP_CONFIG.retention,
      ...overrides.retention
    }
  }
}
