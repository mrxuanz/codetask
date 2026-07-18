import { execSync } from 'node:child_process'

let testOverride: string | null = null

/**
 * Resolves the current application commit for migration/cutover binding.
 * Prefer git HEAD; fall back to CI env vars; tests may inject via setAppCommitForTests.
 */
export function resolveAppCommit(): string {
  if (testOverride !== null) {
    return testOverride
  }

  const fromEnv = process.env.GIT_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim()
  }

  try {
    const head = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (head) return head
  } catch {
    // not a git checkout or git unavailable
  }

  return 'unknown'
}

/** Test-only override. Pass null to clear. */
export function setAppCommitForTests(commit: string | null): void {
  testOverride = commit
}
