import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { composeDesignModule } from '../../packages/server-core/src/modules/design/index.ts'
import { composeExecutionModule } from '../../packages/server-core/src/modules/execution/index.ts'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { migration045ExecutionModuleTables } from '../../packages/database/src/migrations/execution.ts'

function composeTestModules(db: Database.Database, options?: { startup?: boolean }) {
  const execution = composeExecutionModule({ db })
  const design = composeDesignModule({
    db,
    jobSubmission: execution.submitJob,
    async resolveWorkspaceRoot() {
      return '/tmp/codetask-design-test'
    }
  })
  if (options?.startup) {
    execution.startup()
  }
  return { design, execution }
}

describe('design module (01)', () => {
  it('draft confirm → planning → confirm nodes → publish is idempotent', async () => {
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
    assert.equal(draft.status, 'confirmed')

    const snapshot = await design.drafts.captureConfirmedSnapshot(actor, draft.id)
    const session = await design.planning.createSession({
      actor,
      draftSnapshot: snapshot,
      references: draft.references
    })

    // Snapshot planner runs async; wait briefly for tree.
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
    // Let startPlanning's finally (capacity.release) settle before later db.close().
    await new Promise((r) => setImmediate(r))

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

    const first = await design.planning.publish(
      actor,
      session.id,
      revision,
      'idem-design-publish-1'
    )
    const second = await design.planning.publish(
      actor,
      session.id,
      revision,
      'idem-design-publish-1'
    )
    assert.equal(first.jobId, second.jobId)
    assert.equal(first.session.status, 'published')

    const accepted = db
      .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE id = ?`)
      .get(first.jobId) as { c: number }
    assert.equal(accepted.c, 1)

    const jobRow = db
      .prepare(`SELECT state FROM jobs WHERE id = ?`)
      .get(first.jobId) as { state: string }
    assert.ok(['queued', 'running'].includes(jobRow.state))

    await execution.scheduler.tick()
    design.outbox.stop()
    // Drain any scheduler/outbox microtasks before closing the in-memory db.
    await new Promise((r) => setTimeout(r, 50))
    db.close()
  })

  it('commitExecutionTree rejects stale fencing token', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const execution = composeExecutionModule({ db })

    const { SqliteDraftRepository } = await import(
      '../../packages/server-core/src/modules/design/draft/infrastructure/sqlite-draft-repository.ts'
    )
    const { SqlitePlanningRepository } = await import(
      '../../packages/server-core/src/modules/design/planning/infrastructure/sqlite-planning-repository.ts'
    )
    const { SqlitePlanningCapacity } = await import(
      '../../packages/server-core/src/modules/design/planning/infrastructure/planning-capacity.ts'
    )
    const { JobSubmissionOutbox } = await import(
      '../../packages/server-core/src/modules/design/handoff/job-submission-outbox.ts'
    )
    const { DraftApplication } = await import(
      '../../packages/server-core/src/modules/design/draft/application/draft-application.ts'
    )
    const { PlanningApplication } = await import(
      '../../packages/server-core/src/modules/design/planning/application/planning-application.ts'
    )

    const draftRepo = new SqliteDraftRepository(db)
    const planningRepo = new SqlitePlanningRepository(db)
    const capacity = new SqlitePlanningCapacity(db)
    const outbox = new JobSubmissionOutbox(db, execution.submitJob)
    const drafts = new DraftApplication(draftRepo, {
      resolveWorkspaceRoot: async () => '/tmp/fence'
    })
    const hang = {
      async run() {
        await new Promise(() => {
          /* keep session in planning */
        })
      }
    }
    const planning = new PlanningApplication(
      planningRepo,
      capacity,
      outbox.asPort(),
      { publish() {} },
      hang
    )

    const actor = { userId: 'carol', sessionId: 's' }
    let draft = await drafts.create(actor, {
      projectId: 'p',
      title: 'Fence',
      requirementsMarkdown: 'req'
    })
    draft = await drafts.patchAbilities(actor, draft.id, draft.lockRevision, [
      {
        abilityCode: 'general',
        label: 'G',
        description: 'd',
        reason: 'r',
        recommendedCoreCode: 'opencode'
      }
    ])
    draft = await drafts.patchExecutionProfile(actor, draft.id, draft.lockRevision, {
      plannerCoreCode: 'opencode',
      sliceVerifierCoreCode: 'opencode',
      milestoneVerifierCoreCode: 'opencode'
    })
    draft = await drafts.confirm(actor, draft.id, draft.lockRevision)
    const snapshot = await drafts.captureConfirmedSnapshot(actor, draft.id)
    const session = await planning.createSession({
      actor,
      draftSnapshot: snapshot,
      references: []
    })

    await new Promise((r) => setTimeout(r, 30))
    const current = await planning.get(actor, session.id)
    assert.equal(current.session.status, 'planning')

    await assert.rejects(
      () =>
        planning.commitExecutionTree({
          sessionId: session.id,
          fencingToken: 'fence-forged',
          tree: {
            treeId: 'tree-x',
            planningSessionId: session.id,
            revision: 0,
            milestones: []
          }
        }),
      (error: unknown) => error instanceof Error && error.message.includes('fencing')
    )

    outbox.stop()
    db.close()
  })

  it('tree patch with stale revision conflicts', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migration043DesignModuleTables.up(db)
    migration045ExecutionModuleTables.up(db)

    const { design } = composeTestModules(db)
    const actor = { userId: 'bob', sessionId: 's' }
    let draft = await design.drafts.create(actor, {
      projectId: 'p',
      title: 'T',
      requirementsMarkdown: 'req'
    })
    draft = await design.drafts.patchAbilities(actor, draft.id, draft.lockRevision, [
      {
        abilityCode: 'general',
        label: 'G',
        description: 'd',
        reason: 'r',
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
      references: []
    })
    let tree = null
    for (let i = 0; i < 50; i += 1) {
      const current = await design.planning.get(actor, session.id)
      if (current.tree) {
        tree = current.tree
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(tree)
    // Let startPlanning's finally settle before db.close().
    await new Promise((r) => setImmediate(r))
    const nodeId = tree!.milestones[0]!.id
    await assert.rejects(
      () =>
        design.planning.patchNode(actor, session.id, nodeId, {
          expectedRevision: tree!.revision - 1,
          title: 'stale'
        }),
      /conflict|Conflict/i
    )
    design.outbox.stop()
    db.close()
  })
})
