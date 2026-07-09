import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildWizardPhasePromptSection } from '../../src/server/wizard/prompts'
import { WIZARD_PHASE_DRAFT_REVIEW } from '../../src/server/wizard/types'

describe('wizard phase prompts', () => {
  it('draft_review prompt forbids propose_task_draft on regenerate', () => {
    const section = buildWizardPhasePromptSection(WIZARD_PHASE_DRAFT_REVIEW)
    assert.match(section, /Never call `propose_task_draft`/)
    assert.match(section, /request_phase_rollback/)
  })
})
