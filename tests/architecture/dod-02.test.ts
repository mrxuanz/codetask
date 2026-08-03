/**
 * Architecture 02 DoD — Execution cutover residuals.
 * @see docs/架构收口/02-Job与Work校验执行调度.md
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

function exists(rel: string): boolean {
  try {
    const st = statSync(join(root, rel))
    return st.isFile() || st.isDirectory()
  } catch {
    return false
  }
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|vue)$/.test(name)) files.push(full)
  }
  return files
}

describe('architecture 02 DoD', () => {
  it('legacy host plan/corpus façades are removed', () => {
    assert.equal(exists('src/server/db/job-plan.ts'), false)
    assert.equal(exists('src/server/db/design-plan.ts'), false)
    assert.equal(exists('src/server/reference-corpus/service.ts'), false)
    assert.equal(exists('src/server/reference-corpus/corpus-sync.ts'), false)
  })

  it('no live inserts into thread_jobs outside migrations/tests', () => {
    const live = walk(join(root, 'src')).filter((file) => !/[\\/]migrations[\\/]/.test(file))
    const offenders: string[] = []
    for (const file of live) {
      const text = readFileSync(file, 'utf8')
      if (/\.insert\(\s*threadJobs\s*\)/.test(text) || /insert\(threadJobs\)/.test(text)) {
        offenders.push(file.slice(root.length + 1))
      }
    }
    assert.deepEqual(offenders, [])
  })

  it('project deletion drains Execution jobs and legacy planning-job delete is gone', () => {
    const deletion = readFileSync(join(root, 'src/server/infra/deletion-coordinator.ts'), 'utf8')
    assert.doesNotMatch(deletion, /drainAndDeletePlanningJob/)
    assert.match(deletion, /childExecutionJobIds/)
    assert.match(deletion, /ensureProjectExecutionJobsDeleted/)
    assert.match(deletion, /DELETE FROM jobs WHERE/)
  })

  it('workspace lease conflict resolves via Execution jobs (no thread_jobs)', () => {
    const service = readFileSync(join(root, 'src/server/projects/service.ts'), 'utf8')
    assert.match(service, /ownerKind !== 'job-run'/)
    assert.match(service, /FROM jobs WHERE/)
    assert.doesNotMatch(service, /threadJobs/)
  })
})
