import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mapAssistantMessageToLegacy,
  mapDraftToLegacySummary,
  mapPlanNodesToLegacy,
  mapPlanToLegacyListItem,
  mapThreadToLegacyAgent,
  mapTurnToLegacyQueued,
  mapTurnToLegacyRecord,
  mapUserMessageToLegacy
} from '../../../src/server/compatibility/legacy-api-mapper.ts'
import type { ThreadProjection } from '../../../src/server/core/application/queries/get-thread.ts'
import type { DraftProjection } from '../../../src/server/core/application/queries/get-draft.ts'
import type { PlanProjection } from '../../../src/server/core/application/queries/get-plan.ts'

describe('legacy-api-mapper', () => {
  it('maps thread projection to legacy agent shape (conversation.sample.json)', () => {
    const thread: ThreadProjection = {
      id: 'thr-example-001',
      projectId: 'prj-example-001',
      ownerUserId: 'demo',
      draftId: null,
      planId: null,
      jobId: null
    }
    const mapped = mapThreadToLegacyAgent(thread, {
      coreCode: 'cursor',
      workspacePath: 'workspace/demo-project',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z'
    })
    assert.equal(mapped.configured, true)
    assert.equal(mapped.agent?.coreCode, 'cursor')
    assert.equal(mapped.agent?.workspacePath, 'workspace/demo-project')
    assert.equal(mapped.sessionId, null)
    assert.equal(mapped.pendingCount, 0)
    assert.equal(mapped.core?.code, 'cursor')
    assert.equal(mapped.core?.available, true)
  })

  it('maps conversation messages and turn DTOs', () => {
    const user = mapUserMessageToLegacy({
      id: 'msg-user-001',
      content: 'Add a hello world page',
      createdAt: '2026-07-01T00:00:01.000Z',
      coreCode: 'cursor'
    })
    assert.equal(user.role, 'user')
    assert.equal(user.kind, 'text')
    assert.deepEqual(user.attachments, [])
    assert.equal(user.wizardPhase, 'chat')

    const assistant = mapAssistantMessageToLegacy({
      id: 'msg-assistant-001',
      content: 'Sure — I can help with that.',
      createdAt: '2026-07-01T00:00:05.000Z',
      coreCode: 'cursor'
    })
    assert.equal(assistant.role, 'assistant')

    const queued = mapTurnToLegacyQueued({
      turnId: 'turn-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      threadId: 'thr-example-001',
      message: 'Explain the project layout',
      status: 'queued'
    })
    assert.equal(queued.status, 'queued')
    assert.equal(queued.revision, 1)
    assert.equal(queued.queuePosition, 1)

    const record = mapTurnToLegacyRecord({
      turnId: 'turn-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      threadId: 'thr-example-001',
      message: 'Explain the project layout',
      status: 'completed',
      username: 'demo',
      createdAtSec: 1719792000
    })
    assert.equal(record.kind, 'chat')
    assert.equal(record.workspaceAccess, 'read_write')
    assert.equal(record.lastError, null)
  })

  it('maps draft projection to legacy thread draft summary', () => {
    const draft: DraftProjection = {
      id: 'draft-001',
      status: 'confirmed',
      revision: 2,
      content: 'Settings dark mode\nAdd a settings page with dark mode toggle',
      projectId: 'prj-example-001',
      threadId: 'thr-example-002'
    }
    const mapped = mapDraftToLegacySummary(draft, {
      messageId: 'msg-draft-001',
      createdAt: '2026-07-01T00:10:00.000Z'
    })
    assert.equal(mapped.draftId, 'draft-001')
    assert.equal(mapped.messageId, 'msg-draft-001')
    assert.equal(mapped.status, 'ready')
    assert.equal(mapped.collecting, false)
    assert.equal(mapped.title, 'Settings dark mode')
    assert.equal(mapped.linkedPlanId, null)
    assert.equal(mapped.plan, null)
  })

  it('maps collecting draft status and plan list item', () => {
    const draft: DraftProjection = {
      id: 'draft-002',
      status: 'collecting',
      revision: 1,
      content: 'WIP',
      projectId: 'p1',
      threadId: 't1'
    }
    assert.equal(mapDraftToLegacySummary(draft).collecting, true)
    assert.equal(mapDraftToLegacySummary(draft).status, 'collecting')

    const plan: PlanProjection = {
      id: 'plan-1',
      revision: 2,
      status: 'editing',
      nodes: [
        { id: 'ms-1', kind: 'milestone', title: 'Settings dark mode', parentId: null },
        {
          id: 'task-1',
          kind: 'task',
          title: 'Implement dark mode toggle',
          parentId: 'ms-1',
          abilityCode: 'implement',
          successCriteria: 'Toggle persists'
        }
      ],
      edges: [],
      executionGeneration: 0,
      threadId: 'thr-example-002',
      draftId: 'draft-001'
    }
    const listItem = mapPlanToLegacyListItem(plan)
    assert.equal(listItem.id, 'plan-1')
    assert.equal(listItem.title, 'Settings dark mode')
    assert.equal(listItem.status, 'plan_editing')
    assert.equal(listItem.planRevision, 2)
    assert.equal(listItem.planConfirmedAt, null)

    const nodes = mapPlanNodesToLegacy(plan)
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0]?.nodeRef, 'task:task-1')
    assert.equal(nodes[0]?.abilityCode, 'implement')
  })

  it('does not accept repository or db handles (pure function surface)', () => {
    // Mapper modules export pure functions only — call with DTO literals.
    const thread: ThreadProjection = {
      id: 't',
      projectId: 'p',
      ownerUserId: 'u',
      draftId: null,
      planId: null,
      jobId: null
    }
    const result = mapThreadToLegacyAgent(thread)
    assert.equal(typeof result.configured, 'boolean')
  })
})
