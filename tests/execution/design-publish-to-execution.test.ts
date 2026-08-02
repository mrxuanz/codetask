import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { composeDesignModule } from '../../packages/server-core/src/modules/design/index.ts'
import { composeExecutionModule } from '../../packages/server-core/src/modules/execution/index.ts'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { migration045ExecutionModuleTables } from '../../packages/database/src/migrations/execution.ts'

function composeTestModules(db: Database.Database) {
  const execution = composeExecutionModule({ db })
  const design = composeDesignModule({
    db,
    jobSubmission: execution.submitJob,
    async resolveWorkspaceRoot() {
      return '/tmp/codetask-design-execution-test'
    }
  })
  execution.startup()
  return { design, execution }
}

describe('design publish → execution succeed', () => {
  it('publish creates jobs row and FakeAgentRuntime runs to succeeded', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const { design, execution } = composeTestModules(db)

    const actor = { userId: 'alice', sessionId: 'sess-1' }
    let draft = await design.drafts.create(actor, {
      projectId: 'proj-1',
      title: 'Build notes app',
      summary: 'Simple notes',
      requirementsMarkdown: '# Requirements\n- create notes'
    })
    draft = await design.drafts.patchAbilities(actor, draft.id, draft.lockRevision, [
      {
        abilityCode: 'general',
        label: 'General',
        description: 'General implementation',
        reason: 'default',
        recommendedCoreCode: 'opencode'
      }
    ])
    draft = await design.drafts.patchExecutionProfile(actor, draft.id, draft.lockRevision, {
      plannerCoreCode: 'opencode',
      sliceVerifierCoreCode: 'opencode',
      milestoneVerifierCoreCode: 'opencode'
    })
    draft = await design.drafts.confirm(actor, draft.id, draft.lockRevision)

    const snapshot = await design.drafts.captureConfirmedSnapshot(actor, draft.id)
    const session = await design.planning.createSession({
      actor,
      draftSnapshot: snapshot,
      references: draft.references
    })

    let tree = null
    for (let i = 0; i < 50; i += 1) {
      const current = await design.planning.get(actor, session.id)
      if (current.session.status === 'plan_editing' && current.tree) {
        tree = current.tree
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(tree, 'expected planner to produce a tree')

    let revision = tree!.revision
    for (const milestone of tree!.milestones) {
      tree = await design.planning.confirmNode(actor, session.id, milestone.id, revision)
      revision = tree.revision
      for (const slice of milestone.slices) {
        tree = await design.planning.confirmNode(actor, session.id, slice.id, revision)
        revision = tree.revision
        for (const task of slice.tasks) {
          tree = await design.planning.confirmNode(actor, session.id, task.id, revision)
          revision = tree.revision
        }
      }
    }

    const published = await design.planning.publish(
      actor,
      session.id,
      revision,
      'idem-design-publish-exec'
    )
    assert.ok(published.jobId)

    const jobRow = db
      .prepare(`SELECT id, state FROM jobs WHERE id = ?`)
      .get(published.jobId) as { id: string; state: string }
    assert.equal(jobRow.id, published.jobId)

    let finalState = jobRow.state
    for (let i = 0; i < 30; i += 1) {
      await execution.scheduler.tick()
      finalState = execution.jobs.query.get(actor, published.jobId).state
      if (finalState === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    assert.equal(finalState, 'succeeded')

    design.outbox.stop()
    execution.drain()
    db.close()
  })
})
