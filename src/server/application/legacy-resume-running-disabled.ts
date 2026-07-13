/**
 * Legacy Resume Running - DISABLED
 *
 * This file documents the removal of automatic resume-running logic.
 * Previously, the reconciler would automatically resume jobs that were
 * in running state with stale runs. This is now handled by the
 * StartupReconciler which uses deterministic decisions:
 *
 * - pause intent → settle to paused
 * - no intent + stale run → settle to failed/recoverable
 * - runtime lost → converge via RuntimeExited
 *
 * The old logic in src/server/jobs/reconcile.ts that did:
 *   if (job.state === 'running') { resumeRunning(job) }
 * should be REMOVED or DISABLED.
 *
 * This is a PR3 requirement: task 41
 */

export const LEGACY_RESUME_RUNNING_DISABLED = true
