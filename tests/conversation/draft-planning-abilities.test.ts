import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ensureDraftPlanningAbilities,
  buildUnlockedDraftPayload,
  buildUnlockedRequirementsContractPayload
} from '../../src/server/conversation/draft/normalize'
import type { TaskLaunchDraftPayload } from '../../src/server/conversation/draft/types'

function emptyDraft(): TaskLaunchDraftPayload {
  return {
    draftId: 'draft-test',
    sourceMessageId: 'msg-test',
    title: 'Test task',
    summary: 'Summary',
    userFlow: '',
    techStack: '',
    nfr: [],
    acceptance: [],
    verification: [],
    outOfScope: [],
    assumptions: [],
    requirementsContract: { markdown: '# Contract', status: 'confirmed', confirmedAt: null },
    workspacePath: '/tmp/workspace',
    status: 'editing',
    linkedPlanId: null,
    lockedSections: {},
    abilities: [],
    references: [],
    sourceAttachments: []
  }
}

describe('ensureDraftPlanningAbilities', () => {
  it('returns the payload unchanged when abilities are already configured', () => {
    const draft = emptyDraft()
    draft.abilities = [
      {
        abilityCode: 'project-setup',
        label: 'Project Setup',
        description: 'Setup',
        reason: 'Need setup',
        recommendedCoreCode: 'codex'
      }
    ]

    const next = ensureDraftPlanningAbilities(draft, 'claude-code')
    assert.equal(next, draft)
    assert.equal(next.abilities.length, 1)
  })

  it('infers default abilities bound to the thread core when none are configured', () => {
    const next = ensureDraftPlanningAbilities(emptyDraft(), 'claude-code')

    assert.ok(next.abilities.length > 0)
    assert.ok(next.abilities.every((ability) => ability.recommendedCoreCode === 'claude-code'))
    assert.ok(next.abilities.some((ability) => ability.abilityCode === 'project-setup'))
    assert.ok(next.abilities.some((ability) => ability.abilityCode === 'frontend-implementation'))
    assert.ok(next.abilities.some((ability) => ability.abilityCode === 'general-implementation'))
  })
})

describe('buildUnlockedDraftPayload', () => {
  it('resets draft status, linked plan, locked sections, and requirements confirmation', () => {
    const draft = emptyDraft()
    draft.status = 'confirmed'
    draft.linkedPlanId = 'ds-old-session'
    draft.lockedSections = { requirementsContract: true, abilities: true }
    draft.requirementsContract = {
      markdown: '# Contract',
      status: 'confirmed',
      confirmedAt: '2026-01-01T00:00:00.000Z'
    }

    const next = buildUnlockedDraftPayload(draft)

    assert.equal(next.status, 'editing')
    assert.equal(next.linkedPlanId, null)
    assert.deepEqual(next.lockedSections, {})
    assert.equal(next.requirementsContract.status, 'pending')
    assert.equal(next.requirementsContract.confirmedAt, null)
    assert.equal(next.requirementsContract.markdown, '# Contract')
  })
})

describe('buildUnlockedRequirementsContractPayload', () => {
  it('unlocks only the requirements contract while keeping draft editable', () => {
    const draft = emptyDraft()
    draft.lockedSections = { requirementsContract: true, abilities: true }
    draft.requirementsContract = {
      markdown: '# Contract',
      status: 'confirmed',
      confirmedAt: '2026-01-01T00:00:00.000Z'
    }

    const next = buildUnlockedRequirementsContractPayload(draft)

    assert.equal(next.status, 'editing')
    assert.equal(next.requirementsContract.status, 'pending')
    assert.equal(next.requirementsContract.confirmedAt, null)
    assert.equal(next.lockedSections.requirementsContract, undefined)
    assert.equal(next.lockedSections.abilities, true)
  })
})
