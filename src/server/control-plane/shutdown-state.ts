/**
 * FIX-PLAN F3-C (§8.4): process-wide draining flag for graceful Legacy shutdown.
 *
 * While draining, the single execution-queue entry rejects new claims and no new plan confirmation
 * may promote a Job to running. In-flight runs are stopped at a safe checkpoint and left
 * auto-recoverable (see `shutdownLegacyApplicationRuntime`). This is distinct from a user pause or
 * user cancel: the executor must NOT treat app shutdown as a generic task failure.
 */

let draining = false

export function isDraining(): boolean {
  return draining
}

export function beginDraining(): void {
  draining = true
}

export function endDraining(): void {
  draining = false
}
