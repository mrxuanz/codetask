/**
 * Provider / sandbox child exit conventions used across CodeTask.
 *
 * Node child_process `exit` events report either a numeric `code` or a `signal`.
 * When only a signal is present, native sandbox helpers normalize to shell-style
 * `128 + signalNumber` (see native linux/windows sandbox runners).
 *
 * Application-level sandbox launcher helpers use sentinel negatives for non-exit cases:
 * - `-1` — turn cancelled, reap timed out, or child closed before exit was polled
 *
 * Prefer checking `code !== null` before treating `signal` as authoritative.
 */

/** Sentinel used when a sandbox child did not exit cleanly (cancel / timeout / closed). */
export const SANDBOX_CANCELLED_EXIT_CODE = -1

/**
 * Map a POSIX signal name to the conventional shell exit status (`128 + n`).
 * Returns null when the signal is unknown.
 */
export function signalToShellExitCode(signal: NodeJS.Signals): number | null {
  const signals: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 10,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15
  }
  const n = signals[signal]
  return n === undefined ? null : 128 + n
}
