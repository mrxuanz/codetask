import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCollectingDraftPayload } from '../../src/server/conversation/draft/collecting'
import { inferWizardPhaseFromThread } from '../../src/server/wizard/phase'
import type { Thread } from '../../src/server/db/schema'
import { WIZARD_PHASE_COLLECT, WIZARD_PHASE_DRAFT_REVIEW } from '../../src/server/wizard/types'
import { THREAD_KIND_CREATE_TASK } from '../../src/server/threads/types'

describe('collecting draft wizard phase', () => {
  it('treats stale collecting flag as finalized when draft has content', () => {
    assert.equal(isCollectingDraftPayload({ collecting: true }), true)
    assert.equal(
      isCollectingDraftPayload({
        collecting: true,
        summary: 'Blog landing page',
        requirementsContract: { markdown: '# CONTRACT', status: 'pending' }
      }),
      false
    )
    assert.equal(isCollectingDraftPayload({ collecting: true, summary: 'Has summary only' }), false)
  })

  it('keeps collect wizard phase when activeDraftId is set during collection', () => {
    const row = {
      activeDraftId: 'msg-draft-1',
      activePlanId: null,
      wizardPhase: WIZARD_PHASE_COLLECT,
      threadKind: THREAD_KIND_CREATE_TASK
    } as Thread
    assert.equal(inferWizardPhaseFromThread(row), WIZARD_PHASE_COLLECT)
  })

  it('uses draft review when activeDraftId is set and wizard phase is not collect', () => {
    const row = {
      activeDraftId: 'msg-draft-1',
      activePlanId: null,
      wizardPhase: WIZARD_PHASE_DRAFT_REVIEW,
      threadKind: THREAD_KIND_CREATE_TASK
    } as Thread
    assert.equal(inferWizardPhaseFromThread(row), WIZARD_PHASE_DRAFT_REVIEW)
  })
})
