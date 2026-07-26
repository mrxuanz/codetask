import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DraftRepo, PlanRepo } from '../../../src/server/core/application/ports/repositories.ts'
import {
  runFakePlanner,
  runPlanEditorSkillStub
} from '../../../src/server/core/skills/builtins/index.ts'
import { BuiltinSkillCatalog } from '../../../src/server/core/application/skills/catalog.ts'

function throwingDraftRepo(): DraftRepo {
  return {
    async get() {
      return undefined
    },
    async save() {
      throw new Error('skill must not call DraftRepo.save')
    }
  }
}

function throwingPlanRepo(): PlanRepo {
  return {
    async get() {
      return undefined
    },
    async save() {
      throw new Error('skill must not call PlanRepo.save')
    }
  }
}

describe('skill boundary', () => {
  it('registers builtin planner and plan-editor in catalog', () => {
    const catalog = new BuiltinSkillCatalog()
    assert.ok(catalog.get('planner'))
    assert.ok(catalog.get('plan-editor'))
    assert.equal(catalog.list().length, 2)
  })

  it('Fake Planner returns deterministic plan_tree and never calls repository.save', () => {
    const drafts = throwingDraftRepo()
    const plans = throwingPlanRepo()
    const proposal = runFakePlanner(
      { draftId: 'draft-1', content: 'Build settings page' },
      { drafts, plans }
    )
    assert.equal(proposal.skillId, 'planner')
    assert.equal(proposal.kind, 'plan_tree')
    assert.ok(Array.isArray(proposal.payload.nodes))
    const nodes = proposal.payload.nodes as unknown[]
    assert.ok(nodes.length >= 3)
    // Calling again yields the same structural shape (deterministic).
    const again = runFakePlanner(
      { draftId: 'draft-1', content: 'Build settings page' },
      { drafts, plans }
    )
    assert.deepEqual(again.payload.nodes, proposal.payload.nodes)
  })

  it('Plan Editor stub returns proposal without repository writes', () => {
    const drafts = throwingDraftRepo()
    const plans = throwingPlanRepo()
    const proposal = runPlanEditorSkillStub(
      { planId: 'plan-1', instruction: 'rename task' },
      { drafts, plans }
    )
    assert.equal(proposal.skillId, 'plan-editor')
    assert.equal(proposal.kind, 'plan_operations')
    assert.deepEqual(proposal.payload.operations, [])
  })
})
