/**
 * Legacy Resume Running — ENABLED (FIX-PLAN F3-A, §8.1)
 *
 * Process interruption (normal app shutdown or a crash) is NOT a user failure. Jobs that were
 * `running` when the process died must AUTO-RESUME on the next boot instead of being settled to
 * `failed` and waiting for the user to press Continue.
 *
 * Recovery semantics (see `src/server/legacy-control-plane/reconcile.ts`):
 *   - user Pause    → stays `paused` across restart (never auto-run)
 *   - user Cancel   → stays `cancelled`
 *   - app shutdown / crash of a `running` Job → keep `running` (recoverable), reset interrupted
 *     in-flight tasks, and re-enter the single execution-queue entry to continue the run
 *   - already-completed tasks are never re-run (guarded by job_tasks status + job_task_attempts)
 *
 * The historical flag below is retained (and re-exported) only for backwards compatibility with a
 * couple of callers/tests. Auto-resume is now the default behaviour, so the flag is `false`.
 */

export const LEGACY_RESUME_RUNNING_DISABLED = false
