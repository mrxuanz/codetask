import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import {
  bootstrapRuntime,
  getAppContext,
  resetAppContextForTests
} from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import { projects } from '../../src/server/db/schema'
import { threadAttachmentsDir } from '../../src/server/data-paths'
import {
  drainAndDeleteProject,
  resetDeletionCoordinatorForTests
} from '../../src/server/infra/deletion-coordinator'

function sqlite(): import('better-sqlite3').Database {
  const client = (getDb() as { $client?: import('better-sqlite3').Database }).$client
  assert.ok(client)
  return client
}

function count(sql: string, ...params: unknown[]): number {
  const row = sqlite()
    .prepare(sql)
    .get(...params) as { n: number }
  return Number(row.n)
}

test('drainAndDeleteProject removes conversation, draft, planning, and attachment dirs', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'project-delete-agg-'))
  bootstrapRuntime({ dataDir })
  resetDeletionCoordinatorForTests()

  t.after(async () => {
    resetDeletionCoordinatorForTests()
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })

  const now = Math.floor(Date.now() / 1000)
  const nowIso = new Date().toISOString()
  const nowMs = Date.now()
  const actorId = 'user'
  const projectId = 'proj-delete-1'
  const conversationId = `conv_${'c'.repeat(32)}`
  const draftId = 'draft_delete_1'
  const planningSessionId = 'plan_delete_1'

  await getDb().insert(projects).values({
    id: projectId,
    actorId,
    title: 'Delete Me',
    workspaceRoot: '/tmp/ws-delete',
    createdAt: now,
    updatedAt: now
  })

  const client = sqlite()
  client
    .prepare(
      `INSERT INTO conversation_threads (
        id, actor_id, project_id, title, title_source, provider_code,
        state, state_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(conversationId, actorId, projectId, 'Chat', 'manual', 'codex', 'active', 0, nowIso, nowIso)

  client
    .prepare(
      `INSERT INTO drafts (
        id, actor_id, project_id, title, summary, user_flow, tech_stack,
        nfr_json, acceptance_json, verification_json, out_of_scope_json, assumptions_json,
        requirements_markdown, requirements_status, locked_sections_json, execution_profile_json,
        workspace_root, status, lock_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '', '', '', '[]', '[]', '[]', '[]', '[]', '', 'pending', '{}', NULL, ?, 'editing', 0, ?, ?)`
    )
    .run(draftId, actorId, projectId, 'Draft', '/tmp/ws-delete', nowMs, nowMs)

  client
    .prepare(
      `INSERT INTO planning_sessions (
        id, actor_id, project_id, source_draft_id, draft_snapshot_json,
        execution_profile_json, planner_settings_snapshot_json, planner_settings_hash,
        status, tree_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '{}', '{}', '{}', '', 'queued', 0, ?, ?)`
    )
    .run(planningSessionId, actorId, projectId, draftId, nowMs, nowMs)

  const attachmentDir = threadAttachmentsDir(getAppContext().dataDir, conversationId)
  mkdirSync(join(attachmentDir, 'att-1'), { recursive: true })
  writeFileSync(join(attachmentDir, 'att-1', 'a.png'), 'png')

  await drainAndDeleteProject(actorId, projectId)

  assert.equal(count(`SELECT COUNT(*) AS n FROM projects WHERE id = ?`, projectId), 0)
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM conversation_threads WHERE project_id = ?`, projectId),
    0
  )
  assert.equal(count(`SELECT COUNT(*) AS n FROM drafts WHERE project_id = ?`, projectId), 0)
  assert.equal(
    count(`SELECT COUNT(*) AS n FROM planning_sessions WHERE project_id = ?`, projectId),
    0
  )
  assert.equal(existsSync(attachmentDir), false)
})
