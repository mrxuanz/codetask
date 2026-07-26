import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mapDraftToLegacySummary,
  mapJobToLegacy,
  mapPlanToLegacyListItem,
  mapThreadToLegacyAgent,
  mapTurnToLegacyQueued
} from '../../../src/server/compatibility/legacy-api-mapper.ts'
import type { JobProjection } from '../../../src/server/core/application/queries/get-job.ts'
import type { DraftProjection } from '../../../src/server/core/application/queries/get-draft.ts'
import type { PlanProjection } from '../../../src/server/core/application/queries/get-plan.ts'
import type { ThreadProjection } from '../../../src/server/core/application/queries/get-thread.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(here, '../../../docs/refactor/fixtures/api')

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'))
}

function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as object).sort()
}

function assertKeysMatch(actual: unknown, expected: unknown, label: string): void {
  const actualKeys = objectKeys(actual)
  const expectedKeys = objectKeys(expected)
  for (const key of expectedKeys) {
    assert.ok(
      actualKeys.includes(key),
      `${label}: mapper missing fixture key "${key}" (have: ${actualKeys.join(', ')})`
    )
  }
}

describe('api-mapper-fixtures', () => {
  it('thread agent mapper keys ⊆ get_thread_agent fixture data', () => {
    const fixture = loadJson('conversation.sample.json') as {
      samples: Array<{ id: string; response: { body: { data: unknown } } }>
    }
    const sample = fixture.samples.find((s) => s.id === 'get_thread_agent')
    assert.ok(sample)
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
    assertKeysMatch(mapped, sample.response.body.data, 'get_thread_agent')
  })

  it('turn queued mapper keys ⊆ start_turn-like fixture fragment', () => {
    const fixture = loadJson('conversation.sample.json') as {
      samples: Array<{ id: string; response: { body: { data: Record<string, unknown> } } }>
    }
    const sample = fixture.samples.find((s) => s.id === 'start_turn' || s.id === 'create_turn')
    const mapped = mapTurnToLegacyQueued({
      turnId: 'turn-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      threadId: 'thr-example-001',
      message: 'hi',
      status: 'queued'
    })
    if (sample) {
      assertKeysMatch(mapped, sample.response.body.data, 'turn queued')
    } else {
      // Fixture may use a different sample id — still assert stable contract keys.
      assert.deepEqual(objectKeys(mapped), ['queuePosition', 'revision', 'status', 'turnId'])
    }
  })

  it('draft summary mapper keys ⊆ list_thread_drafts fixture item', () => {
    const fixture = loadJson('draft-job.sample.json') as {
      samples: Array<{
        id: string
        response: { body: { data: { drafts: Array<Record<string, unknown>> } } }
      }>
    }
    const sample = fixture.samples.find((s) => s.id === 'list_thread_drafts')
    assert.ok(sample)
    const draftItem = sample.response.body.data.drafts[0]
    assert.ok(draftItem)
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
    assertKeysMatch(mapped, draftItem, 'list_thread_drafts item')
  })

  it('plan list item mapper keys ⊆ list_thread_plans fixture item', () => {
    const fixture = loadJson('plan-confirm.sample.json') as {
      samples: Array<{
        id: string
        response: { body: { data: { plans: Array<Record<string, unknown>> } } }
      }>
    }
    const sample = fixture.samples.find((s) => s.id === 'list_thread_plans')
    assert.ok(sample)
    const planItem = sample.response.body.data.plans[0]
    assert.ok(planItem)
    const plan: PlanProjection = {
      id: 'job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      revision: 2,
      status: 'editing',
      nodes: [{ id: 'ms-1', kind: 'milestone', title: 'Settings dark mode', parentId: null }],
      edges: [],
      executionGeneration: 0,
      threadId: 'thr-example-002',
      draftId: 'draft-001'
    }
    const mapped = mapPlanToLegacyListItem(plan)
    assertKeysMatch(mapped, planItem, 'list_thread_plans item')
  })

  it('job mapper keys ⊆ pause_job fixture job object', () => {
    const fixture = loadJson('job-control.sample.json') as {
      legacy: {
        samples: Array<{
          id: string
          response: { body: { data: { job: Record<string, unknown> } } }
        }>
      }
    }
    const sample = fixture.legacy.samples.find((s) => s.id === 'pause_job')
    assert.ok(sample)
    const fixtureJob = sample.response.body.data.job
    const job: JobProjection = {
      id: 'job-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      status: 'pausing',
      planRevision: 1,
      executionGeneration: 1,
      stateRevision: 13,
      threadId: 'thr-example-002',
      draftMessageId: 'msg-draft-001',
      title: 'Settings dark mode',
      summary: 'Add a settings page with dark mode toggle',
      createdAt: 1719792600,
      updatedAt: 1719793000
    }
    const mapped = mapJobToLegacy(job)
    // Fixture pause sample is a partial job — require those keys present on mapper output.
    assertKeysMatch(mapped, fixtureJob, 'pause_job')
    assert.equal(mapped.status, 'pausing')
    assert.equal(mapped.suspensionKind, 'user_requested')
  })
})
