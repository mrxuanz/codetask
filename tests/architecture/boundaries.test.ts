import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('._')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(full)
  }
  return files
}

describe('architecture boundaries (01+02)', () => {
  it('server-core design module does not import Conversation service or Electron', () => {
    const designRoot = join(root, 'packages/server-core/src/modules/design')
    const files = walk(designRoot)
    assert.ok(files.length > 0, 'design module files exist')
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      assert.equal(
        /from ['"]electron['"]|require\(['"]electron['"]\)/.test(source),
        false,
        `${file} must not import electron`
      )
      assert.equal(
        /conversation\/service|modules\/conversation/.test(source),
        false,
        `${file} must not import Conversation service`
      )
      assert.equal(
        /legacy-control-plane|workload-slot|claimWorkloadSlot/.test(source),
        false,
        `${file} must not import Legacy workload/control-plane`
      )
    }
  })

  it('server-core execution module does not import Design repositories or Electron', () => {
    const executionRoot = join(root, 'packages/server-core/src/modules/execution')
    const files = walk(executionRoot)
    assert.ok(files.length > 0, 'execution module files exist')
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      assert.equal(/electron/.test(source), false, `${file} must not import electron`)
      assert.equal(
        /modules\/design\/draft|SqliteDraftRepository|SqlitePlanningRepository/.test(source),
        false,
        `${file} must not import Design repositories`
      )
      assert.equal(
        /legacy-control-plane/.test(source),
        false,
        `${file} must not import legacy-control-plane`
      )
      assert.equal(
        /process\.env\.(FEATURE_|USE_V3|CODETASK_CUTOVER)/.test(source),
        false,
        `${file} must not use cutover env flags`
      )
    }
  })

  it('packages/server-core create-app does not import electron', () => {
    const source = readFileSync(join(root, 'packages/server-core/src/create-app.ts'), 'utf8')
    assert.equal(/electron/.test(source), false)
  })

  it('contracts expose JobSubmission, JobState, and DraftSnapshot', () => {
    const design = readFileSync(join(root, 'packages/contracts/src/design.ts'), 'utf8')
    assert.match(design, /JobSubmissionSchema/)
    assert.match(design, /DraftSnapshotSchema/)
    assert.match(design, /ExecutionTreeSnapshotSchema/)
    const execution = readFileSync(join(root, 'packages/contracts/src/execution.ts'), 'utf8')
    assert.match(execution, /JobStateSchema/)
    assert.match(execution, /WorkStateSchema/)
  })

  it('legacy thread_job Planner HTTP MCP is removed', () => {
    const plannerMcp = join(root, 'src/server/planner/mcp')
    let exists = true
    try {
      readdirSync(plannerMcp)
    } catch {
      exists = false
    }
    assert.equal(exists, false)
  })

  it('legacy-control-plane directory is removed', () => {
    const legacy = join(root, 'src/server/legacy-control-plane')
    let exists = true
    try {
      readdirSync(legacy)
    } catch {
      exists = false
    }
    assert.equal(exists, false)
  })

  it('v3 control-plane stack and cutover marker modules are removed', () => {
    const gone = [
      'src/server/application/control-plane-runtime.ts',
      'src/server/application/cutover-state.ts',
      'src/server/infra/sqlite/control-plane',
      'src/shared/contracts/control-plane',
      'tests/control-plane',
      'scripts/control-plane'
    ]
    for (const rel of gone) {
      let exists = true
      try {
        const full = join(root, rel)
        const st = statSync(full)
        exists = st.isFile() || st.isDirectory()
      } catch {
        exists = false
      }
      assert.equal(exists, false, `${rel} should be removed`)
    }
  })

  it('ThreadJobDto is removed; PlanningSessionViewDto lives in @codetask/contracts', () => {
    const jobs = readFileSync(join(root, 'packages/contracts/src/ui-jobs.ts'), 'utf8')
    assert.equal(/export (interface|type) ThreadJobDto/.test(jobs), false)
    const planning = readFileSync(join(root, 'packages/contracts/src/ui-planning.ts'), 'utf8')
    assert.match(planning, /export type PlanningSessionViewDto/)
  })

  it('migration 047 drops control_* tables', () => {
    const drop = readFileSync(
      join(root, 'packages/database/src/migrations/drop-control-plane.ts'),
      'utf8'
    )
    assert.match(drop, /control_jobs/)
    assert.match(drop, /DROP TABLE IF EXISTS/)
    const index = readFileSync(join(root, 'src/server/db/migrations/index.ts'), 'utf8')
    assert.match(index, /migration047DropControlPlane/)
  })

  it('execution UI uses ExecutionJob type alias, not ThreadJob', () => {
    const jobsApi = readFileSync(join(root, 'apps/web/src/api/jobs-api.ts'), 'utf8')
    assert.equal(/export type ThreadJob\s*=/.test(jobsApi), false)
    assert.equal(/export type ExecutionJob\s*=/.test(jobsApi), true)
  })

  it('conversation module and migrations 048-050 are registered (03)', () => {
    const index = readFileSync(join(root, 'src/server/db/migrations/index.ts'), 'utf8')
    assert.match(index, /migration048ConversationModule/)
    assert.match(index, /migration049ConversationData/)
    assert.match(index, /migration050ConversationCleanupTables/)
    const convIndex = readFileSync(
      join(root, 'packages/server-core/src/modules/conversation/index.ts'),
      'utf8'
    )
    assert.match(convIndex, /composeConversationModule/)
    const runtime = readFileSync(join(root, 'packages/agent-runtime/src/index.ts'), 'utf8')
    assert.match(runtime, /createAgentRuntime/)
    assert.doesNotMatch(runtime, /create_task/)
  })

  it('legacy turn-queue and unmounted thread routes are removed (03)', () => {
    const gone = [
      'src/server/conversation/turn-queue.ts',
      'src/server/routes/threads.ts',
      'src/server/routes/turns.ts',
      'src/server/conversation/turn-policy/create-task.ts',
      'src/server/legacy-draft/execution-config.ts'
    ]
    for (const rel of gone) {
      let exists = true
      try {
        const st = statSync(join(root, rel))
        exists = st.isFile() || st.isDirectory()
      } catch {
        exists = false
      }
      assert.equal(exists, false, `${rel} should be removed`)
    }
  })

  it('Design module accepts shared AgentRuntime without importing Conversation', () => {
    const design = readFileSync(
      join(root, 'packages/server-core/src/modules/design/index.ts'),
      'utf8'
    )
    assert.match(design, /agentRuntime\?:/)
    assert.doesNotMatch(design, /modules\/conversation/)
  })

  it('conversation/draft and src/server/wizard are removed (03)', () => {
    assert.equal(pathExists('src/server/conversation/draft'), false)
    assert.equal(pathExists('src/server/wizard'), false)
  })
})

function pathExists(rel: string): boolean {
  try {
    const st = statSync(join(root, rel))
    return st.isFile() || st.isDirectory()
  } catch {
    return false
  }
}
