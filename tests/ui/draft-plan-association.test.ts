import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PlanningSessionViewDto } from '@codetask/contracts'
import { findLatestPlanForDraft } from '../../apps/web/src/lib/draftPlanAssociation.ts'

function plan(id: string, draftMessageId: string, updatedAt: string): PlanningSessionViewDto {
  return {
    id,
    draftMessageId,
    title: id,
    summary: '',
    status: 'plan_editing',
    planProgress: {
      phase: 'plan_ready',
      status: 'completed',
      contextsRegistered: 1,
      contextsTotal: 1
    },
    taskProgress: { phase: 'idle', status: 'pending', currentIndex: 0, total: 0, tasks: [] },
    abilities: [],
    createdAt: updatedAt,
    updatedAt
  }
}

test('draft-plan association falls back to source draft id and chooses the latest plan', () => {
  const selected = findLatestPlanForDraft('draft-1', [
    plan('plan-old', 'draft-1', '2026-01-01T00:00:00.000Z'),
    plan('plan-other', 'draft-2', '2026-03-01T00:00:00.000Z'),
    plan('job-new', 'draft-1', '2026-02-01T00:00:00.000Z')
  ])
  assert.equal(selected?.id, 'job-new')
})
