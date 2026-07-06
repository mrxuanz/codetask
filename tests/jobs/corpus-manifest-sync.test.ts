import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrations } from '../../src/server/db/migrations'
import {
  findPlanReferenceIdsMissingFromCorpus,
  isManifestFresh,
  referenceManifestStaleReason
} from '../../src/server/reference-corpus/corpus-sync'
import { validateLaunchPreconditions } from '../../src/server/design-session/launch'
import { buildJobReferenceManifest } from '../../src/shared/job-references'
import type { SavedJobPlan } from '../../src/shared/contracts/plan'
import type { DesignSession } from '../../src/server/db/schema'
import { AppError } from '../../src/server/error'

test('migration 021 adds corpus revision columns', () => {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applyMigrations(sqlite)

  const cols = sqlite.prepare(`PRAGMA table_info(design_sessions)`).all() as Array<{ name: string }>
  const names = new Set(cols.map((col) => col.name))
  assert.ok(names.has('corpus_revision'))
  assert.ok(names.has('frozen_corpus_revision'))
  sqlite.close()
})

test('isManifestFresh requires frozen corpus revision to match', () => {
  assert.equal(
    isManifestFresh({ manifestRevision: 1, corpusRevision: 2, frozenCorpusRevision: 1 }),
    false
  )
  assert.equal(
    isManifestFresh({ manifestRevision: 2, corpusRevision: 2, frozenCorpusRevision: 2 }),
    true
  )
  assert.equal(
    isManifestFresh({ manifestRevision: 0, corpusRevision: 0, frozenCorpusRevision: 0 }),
    false
  )
})

test('findPlanReferenceIdsMissingFromCorpus detects removed refs', () => {
  const plan: SavedJobPlan = {
    milestones: [],
    tasks: [
      {
        id: 'm1-s1-t1',
        milestoneIndex: 1,
        sliceIndex: 1,
        taskIndex: 1,
        title: 'T1',
        description: 'd',
        taskKind: 'general-implementation',
        abilityCode: 'general-implementation',
        contextMarkdown: 'ctx',
        successCriteria: 'done',
        referenceIds: ['ref-a', 'ref-missing']
      }
    ]
  }
  assert.deepEqual(findPlanReferenceIdsMissingFromCorpus(plan, new Set(['ref-a'])), ['ref-missing'])
})

function sampleSession(overrides: Partial<DesignSession> = {}): DesignSession {
  return {
    id: 'ds-test',
    threadId: 'thread-1',
    username: 'user',
    draftMessageId: 'msg-1',
    title: 'Test',
    summary: '',
    workspaceRoot: '/workspace/project',
    phase: 'ready_to_launch',
    draftRevision: 2,
    planRevision: 1,
    status: 'plan_editing',
    planPhase: 'plan_ready',
    planStatus: 'completed',
    planContextsRegistered: 1,
    planContextsTotal: 1,
    planMessage: null,
    planCountsJson: '{}',
    taskPhase: 'idle',
    taskStatus: 'pending',
    taskCurrentIndex: 0,
    taskTotal: 1,
    taskCurrentTaskId: null,
    taskMessage: null,
    taskMetaJson: '{}',
    referenceManifestJson: null,
    manifestRevision: 1,
    corpusRevision: 2,
    frozenCorpusRevision: 1,
    planArtifactId: null,
    planArtifactPath: null,
    planSummaryJson: null,
    draftConfirmedAt: 1,
    launchedJobId: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function samplePlan(): SavedJobPlan {
  return {
    milestones: [
      {
        title: 'M1',
        successCriteria: 'done',
        confirmed: true,
        slices: [
          {
            title: 'S1',
            successCriteria: 'done',
            confirmed: true,
            tasks: [
              {
                title: 'T1',
                description: 'd',
                taskKind: 'general-implementation',
                abilityCode: 'general-implementation',
                confirmed: true
              }
            ]
          }
        ]
      }
    ],
    tasks: [
      {
        id: 'm1-s1-t1',
        milestoneIndex: 1,
        sliceIndex: 1,
        taskIndex: 1,
        title: 'T1',
        description: 'd',
        taskKind: 'general-implementation',
        abilityCode: 'general-implementation',
        contextMarkdown: 'ctx',
        successCriteria: 'done',
        confirmed: true
      }
    ]
  }
}

test('validateLaunchPreconditions rejects stale manifest', () => {
  const manifest = buildJobReferenceManifest({
    jobId: 'ds-test',
    threadId: 'thread-1',
    references: []
  })
  assert.throws(
    () =>
      validateLaunchPreconditions({
        session: sampleSession(),
        plan: samplePlan(),
        manifest
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError)
      assert.equal(error.data.turnErrorCode, 'draft.manifest_not_ready')
      return true
    }
  )
})

test('referenceManifestStaleReason explains missing freeze', () => {
  assert.equal(
    referenceManifestStaleReason({
      manifestRevision: 0,
      corpusRevision: 0,
      frozenCorpusRevision: 0
    }),
    'Reference corpus has not been frozen yet'
  )
})
