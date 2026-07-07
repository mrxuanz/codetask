import assert from 'node:assert/strict'
import test from 'node:test'
import type { Thread } from '../../src/server/db/schema'
import { resolveThreadWizardPhaseWrite } from '../../src/server/wizard/phase'
import {
  WIZARD_PHASE_COLLECT,
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT
} from '../../src/server/wizard/types'

function threadRow(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    username: 'user',
    projectId: 'proj-1',
    title: 't',
    titleSource: 'auto',
    status: 'draft',
    conversationId: 'conv-1',
    coreCode: 'codex',
    runtimeStatus: 'idle',
    runtimeSessionId: null,
    coreRuntimeJson: '{}',
    lastError: null,
    lastUsedAt: null,
    activeDraftId: null,
    activePlanId: null,
    wizardPhase: WIZARD_PHASE_COLLECT,
    threadKind: 'create_task',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Thread
}

test('collecting_draft always writes collect', () => {
  assert.equal(
    resolveThreadWizardPhaseWrite(threadRow({ wizardPhase: WIZARD_PHASE_DRAFT_REVIEW }), {
      type: 'collecting_draft'
    }),
    WIZARD_PHASE_COLLECT
  )
})

test('infer_from_context keeps phase unchanged for collecting placeholder draft', () => {
  assert.equal(
    resolveThreadWizardPhaseWrite(threadRow(), {
      type: 'infer_from_context',
      activeDraftId: 'draft-1',
      draftIsPlaceholder: true
    }),
    undefined
  )
})

test('infer_from_context advances mature draft to draft_review', () => {
  assert.equal(
    resolveThreadWizardPhaseWrite(threadRow(), {
      type: 'infer_from_context',
      activeDraftId: 'draft-1',
      draftIsPlaceholder: false
    }),
    WIZARD_PHASE_DRAFT_REVIEW
  )
})

test('infer_from_context selects plan when activePlanId is set', () => {
  assert.equal(
    resolveThreadWizardPhaseWrite(threadRow(), {
      type: 'infer_from_context',
      activeDraftId: 'draft-1',
      activePlanId: 'plan-1'
    }),
    WIZARD_PHASE_PLAN_EDIT
  )
})

test('set intent writes explicit target phase', () => {
  assert.equal(
    resolveThreadWizardPhaseWrite(threadRow(), {
      type: 'set',
      phase: WIZARD_PHASE_PLAN_EDIT
    }),
    WIZARD_PHASE_PLAN_EDIT
  )
})
