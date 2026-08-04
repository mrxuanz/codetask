/**
 * Architecture residual DoD — M3 live paths off thread_jobs.
 * @see docs/架构收口/残差进度.md
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

const LIVE_FILES = [
  'src/server/projects/service.ts',
  'src/server/retention/janitor.ts',
  'src/server/retention/lifecycle.ts',
  'src/server/infra/deletion-coordinator.ts'
] as const

describe('architecture residual DoD — M3', () => {
  it('live paths do not import or query drizzle threadJobs', () => {
    for (const rel of LIVE_FILES) {
      const text = readFileSync(join(root, rel), 'utf8')
      assert.doesNotMatch(text, /\bthreadJobs\b/, rel)
      assert.doesNotMatch(text, /from\(threadJobs\)/, rel)
    }
  })

  it('projects lease conflict covers job-run and Execution jobs', () => {
    const service = readFileSync(join(root, 'src/server/projects/service.ts'), 'utf8')
    assert.match(service, /'job-run'/)
    assert.match(service, /FROM jobs WHERE/)
  })

  it('janitor attachment prune uses Design/Execution SQL', () => {
    const janitor = readFileSync(join(root, 'src/server/retention/janitor.ts'), 'utf8')
    assert.match(janitor, /design_draft_references/)
    assert.match(janitor, /job_snapshots/)
  })

  it('lifecycle terminal path writes Execution jobs and reads design_plan_revisions', () => {
    const lifecycle = readFileSync(join(root, 'src/server/retention/lifecycle.ts'), 'utf8')
    assert.match(lifecycle, /UPDATE jobs SET terminal_at/)
    assert.match(lifecycle, /designPlanRevisions/)
    assert.doesNotMatch(lifecycle, /taskMetaJson/)
  })

  it('deletion prefers Execution jobs helpers', () => {
    const deletion = readFileSync(join(root, 'src/server/infra/deletion-coordinator.ts'), 'utf8')
    assert.match(deletion, /readExecutionJobRow/)
    assert.match(deletion, /DELETE FROM jobs WHERE/)
    assert.match(deletion, /releaseWorkspaceLeaseForOwner\('job-run'/)
  })
})
