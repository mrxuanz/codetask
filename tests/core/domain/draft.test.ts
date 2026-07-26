import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  abandonDraft,
  asDraftId,
  assertDraftEditable,
  confirmDraft,
  confirmDraftSection,
  createDraft,
  DraftDomainError,
  type Draft,
  type DraftStatus,
  unlockDraft,
  updateCollectingContent,
  updateCollectingPayload
} from '@server/core/domain/drafts'

function collectingDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    ...createDraft({
      id: asDraftId('draft-1'),
      projectId: 'project-1',
      threadId: 'thread-1',
      content: 'initial'
    }),
    ...overrides
  }
}

test('createDraft starts collecting at revision 1', () => {
  const draft = createDraft({
    id: asDraftId('draft-1'),
    projectId: 'project-1',
    threadId: 'thread-1',
    content: 'hello'
  })
  assert.equal(draft.status, 'collecting')
  assert.equal(draft.revision, 1)
  assert.equal(draft.content, 'hello')
  assert.equal(draft.projectId, 'project-1')
  assert.equal(draft.threadId, 'thread-1')
  assert.equal(draft.id, asDraftId('draft-1'))
})

const legalCases: Array<{
  name: string
  run: () => void
}> = [
  {
    name: 'updateCollectingContent while collecting',
    run: () => {
      const draft = collectingDraft()
      const next = updateCollectingContent(draft, 'updated')
      assert.equal(next.status, 'collecting')
      assert.equal(next.content, 'updated')
      assert.equal(next.revision, draft.revision + 1)
    }
  },
  {
    name: 'confirmDraft from collecting',
    run: () => {
      const draft = collectingDraft()
      const next = confirmDraft(draft)
      assert.equal(next.status, 'confirmed')
      assert.equal(next.content, draft.content)
      assert.equal(next.revision, draft.revision)
    }
  },
  {
    name: 'abandonDraft from collecting',
    run: () => {
      const draft = collectingDraft()
      const next = abandonDraft(draft)
      assert.equal(next.status, 'abandoned')
      assert.equal(next.content, draft.content)
      assert.equal(next.revision, draft.revision)
    }
  },
  {
    name: 'assertDraftEditable allows collecting',
    run: () => {
      assert.doesNotThrow(() => assertDraftEditable(collectingDraft()))
    }
  },
  {
    name: 'updateCollectingPayload merges sections and bumps revision',
    run: () => {
      const draft = collectingDraft({
        payload: { sections: { summary: { content: 'a', locked: false } } }
      })
      const next = updateCollectingPayload(draft, {
        content: 'body',
        payload: {
          wizardPhase: 'draft_review',
          sections: { summary: { content: 'b' }, acceptance: { content: 'c' } }
        }
      })
      assert.equal(next.content, 'body')
      assert.equal(next.revision, draft.revision + 1)
      assert.equal(next.payload?.wizardPhase, 'draft_review')
      assert.equal(next.payload?.sections?.summary?.content, 'b')
      assert.equal(next.payload?.sections?.acceptance?.content, 'c')
    }
  },
  {
    name: 'confirmDraftSection locks section',
    run: () => {
      const draft = collectingDraft()
      const next = confirmDraftSection(draft, 'acceptance')
      assert.equal(next.payload?.sections?.acceptance?.locked, true)
      assert.equal(next.revision, draft.revision + 1)
      const again = confirmDraftSection(next, 'acceptance')
      assert.equal(again, next)
    }
  },
  {
    name: 'unlockDraft confirmed → collecting clears planId',
    run: () => {
      const confirmed = confirmDraft(
        collectingDraft({ payload: { planId: 'plan-1', jobId: 'job-1' } })
      )
      const unlocked = unlockDraft(confirmed)
      assert.equal(unlocked.status, 'collecting')
      assert.equal(unlocked.payload?.planId, null)
      assert.equal(unlocked.payload?.jobId, null)
      assert.equal(unlocked.revision, confirmed.revision + 1)
    }
  }
]

for (const { name, run } of legalCases) {
  test(`legal: ${name}`, run)
}

const illegalCases: Array<{
  name: string
  status: DraftStatus
  run: (draft: Draft) => void
  code: string
}> = [
  {
    name: 'updateCollectingContent after confirm',
    status: 'confirmed',
    code: 'draft.not_editable',
    run: (draft) => updateCollectingContent(draft, 'nope')
  },
  {
    name: 'updateCollectingContent after abandon',
    status: 'abandoned',
    code: 'draft.not_editable',
    run: (draft) => updateCollectingContent(draft, 'nope')
  },
  {
    name: 'confirmDraft when already confirmed',
    status: 'confirmed',
    code: 'draft.not_collecting',
    run: (draft) => confirmDraft(draft)
  },
  {
    name: 'confirmDraft when abandoned',
    status: 'abandoned',
    code: 'draft.not_collecting',
    run: (draft) => confirmDraft(draft)
  },
  {
    name: 'abandonDraft when confirmed',
    status: 'confirmed',
    code: 'draft.not_collecting',
    run: (draft) => abandonDraft(draft)
  },
  {
    name: 'abandonDraft when already abandoned',
    status: 'abandoned',
    code: 'draft.not_collecting',
    run: (draft) => abandonDraft(draft)
  },
  {
    name: 'assertDraftEditable when confirmed',
    status: 'confirmed',
    code: 'draft.not_editable',
    run: (draft) => assertDraftEditable(draft)
  },
  {
    name: 'assertDraftEditable when abandoned',
    status: 'abandoned',
    code: 'draft.not_editable',
    run: (draft) => assertDraftEditable(draft)
  },
  {
    name: 'updateCollectingPayload after confirm',
    status: 'confirmed',
    code: 'draft.not_editable',
    run: (draft) => updateCollectingPayload(draft, { content: 'nope' })
  },
  {
    name: 'confirmDraftSection after abandon',
    status: 'abandoned',
    code: 'draft.not_editable',
    run: (draft) => confirmDraftSection(draft, 'summary')
  },
  {
    name: 'unlockDraft when abandoned',
    status: 'abandoned',
    code: 'draft.not_unlockable',
    run: (draft) => unlockDraft(draft)
  }
]

for (const { name, status, run, code } of illegalCases) {
  test(`illegal: ${name}`, () => {
    const draft = collectingDraft({ status })
    assert.throws(
      () => run(draft),
      (err: unknown) => {
        assert.ok(err instanceof DraftDomainError)
        assert.equal(err.code, code)
        return true
      }
    )
  })
}
