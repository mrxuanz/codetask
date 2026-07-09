import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateWizardToolPhaseAccess } from '../../src/server/wizard/edit-guard'
import { WIZARD_PHASE_COLLECT, WIZARD_PHASE_DRAFT_REVIEW } from '../../src/server/wizard/types'

describe('evaluateWizardToolPhaseAccess uses DB resolvedPhase', () => {
  it('allows draft_review tools when DB is draft_review even if session is still collect', () => {
    const block = evaluateWizardToolPhaseAccess({
      toolName: 'get_task_draft',
      wizardStage: WIZARD_PHASE_COLLECT,
      resolvedPhase: WIZARD_PHASE_DRAFT_REVIEW
    })
    assert.equal(block, null)
  })

  it('rejects propose_task_draft when DB advanced to draft_review despite session collect', () => {
    const block = evaluateWizardToolPhaseAccess({
      toolName: 'propose_task_draft',
      wizardStage: WIZARD_PHASE_COLLECT,
      resolvedPhase: WIZARD_PHASE_DRAFT_REVIEW
    })
    assert.ok(block)
    assert.equal(block?.allowed, false)
  })

  it('rejects draft tools when DB is still collect even if session claims draft_review', () => {
    const block = evaluateWizardToolPhaseAccess({
      toolName: 'update_task_draft',
      wizardStage: WIZARD_PHASE_DRAFT_REVIEW,
      resolvedPhase: WIZARD_PHASE_COLLECT
    })
    assert.ok(block)
    assert.equal(block?.allowed, false)
  })

  it('allows propose_task_draft when both session and DB are collect', () => {
    const block = evaluateWizardToolPhaseAccess({
      toolName: 'propose_task_draft',
      wizardStage: WIZARD_PHASE_COLLECT,
      resolvedPhase: WIZARD_PHASE_COLLECT
    })
    assert.equal(block, null)
  })
})
