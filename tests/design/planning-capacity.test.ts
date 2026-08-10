import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { migration066PlanningCapacityIndex } from '../../packages/database/src/migrations/planning-capacity-index.ts'
import { SqlitePlanningCapacity } from '../../packages/server-core/src/modules/design/planning/infrastructure/planning-capacity.ts'

test('planning capacity is exclusive and expired leases are reclaimed', async () => {
  const db = new Database(':memory:')
  migration043DesignModuleTables.up(db)
  migration066PlanningCapacityIndex.up(db)
  db.prepare(
    `INSERT INTO drafts (
      id, actor_id, project_id, title, workspace_root, created_at, updated_at
    ) VALUES ('draft-capacity', 'actor', 'project', 'Capacity', '/tmp/capacity', 1, 1)`
  ).run()
  const insertSession = db.prepare(
    `INSERT INTO planning_sessions (
      id, actor_id, project_id, source_draft_id, draft_snapshot_json,
      execution_profile_json, created_at, updated_at
    ) VALUES (?, 'actor', 'project', 'draft-capacity', '{}', '{}', 1, 1)`
  )
  for (const sessionId of ['session-a', 'session-b', 'session-c']) {
    insertSession.run(sessionId)
  }
  const capacity = new SqlitePlanningCapacity(db, 1, 20)

  const first = await capacity.acquire({ planningSessionId: 'session-a', pool: 'planner' })
  assert.ok(first)
  assert.equal(await capacity.acquire({ planningSessionId: 'session-b', pool: 'planner' }), null)

  db.prepare(`UPDATE planning_capacity_leases SET acquired_at = 0 WHERE id = ?`).run(first.leaseId)
  const reclaimed = await capacity.acquire({ planningSessionId: 'session-b', pool: 'planner' })
  assert.ok(reclaimed)

  await capacity.heartbeat(reclaimed.leaseId)
  const row = db
    .prepare(`SELECT acquired_at AS acquiredAt FROM planning_capacity_leases WHERE id = ?`)
    .get(reclaimed.leaseId) as { acquiredAt: number }
  assert.ok(row.acquiredAt > 0)

  await capacity.release(reclaimed.leaseId)
  assert.ok(await capacity.acquire({ planningSessionId: 'session-c', pool: 'planner' }))
  db.close()
})
