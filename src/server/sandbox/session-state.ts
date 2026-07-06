export type SandboxSessionState =
  | 'starting'
  | 'running'
  | 'finishing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'cleanup_failed'

export type SandboxReapStatus = 'exited' | 'cancelled' | 'timed_out'

export const DEFAULT_SANDBOX_TURN_TIMEOUT_MS = 30 * 60 * 1000

export const SANDBOX_REAP_POLL_MS = 25
