import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { applyMigrations } from '../../src/server/db/migrations'
import { isPlanFullyConfirmed } from '../../src/shared/plan-mutations'
import type { SavedJobPlan } from '../../src/shared/contracts/plan'
import {
  buildJobSnapshot,
  validateLaunchPreconditions
} from '../../src/server/design-session/launch'
import type { ThreadJob } from '../../src/server/db/schema'
import { buildJobReferenceManifest } from '../../src/shared/job-references'
import { AppError } from '../../src/server/error'
import { ReferenceFileMissingError } from '../../src/server/jobs/reference-paths'

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

function sampleSession(overrides: Partial<ThreadJob> = {}): ThreadJob {
  return {
    id: 'ds-test',
    threadId: 'thread-1',
    username: 'user',
    draftMessageId: 'msg-1',
    title: 'Test',
    summary: '',
    workspacePath: '/workspace/project',
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
    corpusRevision: 1,
    frozenCorpusRevision: 1,
    planArtifactId: null,
    planArtifactPath: null,
    planSummaryJson: null,
    draftConfirmedAt: 1,
    planConfirmedAt: null,
    designSessionId: null,
    snapshotDraftRevision: null,
    snapshotPlanRevision: null,
    snapshotManifestRevision: null,
    executionLeaseOwner: null,
    executionLeaseExpiresAt: null,
    activeRunId: null,
    terminalAt: null,
    runtimeBytes: 0,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

test('migration 020 adds job snapshot columns to thread_jobs', () => {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  applyMigrations(sqlite)

  const cols = sqlite.prepare(`PRAGMA table_info(thread_jobs)`).all() as Array<{ name: string }>
  const names = new Set(cols.map((col) => col.name))
  assert.ok(names.has('design_session_id'))
  assert.ok(names.has('snapshot_draft_revision'))
  assert.ok(names.has('snapshot_plan_revision'))
  assert.ok(names.has('snapshot_manifest_revision'))
  sqlite.close()
})

test('validateLaunchPreconditions requires frozen manifest', () => {
  const plan = samplePlan()
  const manifest = buildJobReferenceManifest({
    jobId: 'ds-test',
    threadId: 'thread-1',
    references: []
  })

  assert.throws(
    () =>
      validateLaunchPreconditions({
        session: sampleSession({ manifestRevision: 0 }),
        plan,
        manifest: null
      }),
    (error: unknown) =>
      error instanceof AppError && error.data.turnErrorCode === 'draft.manifest_not_ready'
  )

  assert.doesNotThrow(() =>
    validateLaunchPreconditions({
      session: sampleSession({ phase: 'plan_edit' }),
      plan,
      manifest
    })
  )
})

test('validateLaunchPreconditions allows unconfirmed plan nodes', () => {
  const plan = samplePlan()
  plan.milestones[0]!.confirmed = undefined
  assert.equal(isPlanFullyConfirmed(plan), false)

  assert.doesNotThrow(() =>
    validateLaunchPreconditions({
      session: sampleSession(),
      plan,
      manifest: buildJobReferenceManifest({
        jobId: 'ds-test',
        threadId: 'thread-1',
        references: []
      })
    })
  )
})

test('buildJobSnapshot captures revision metadata', () => {
  const session = sampleSession()
  const plan = samplePlan()
  const manifest = buildJobReferenceManifest({
    jobId: 'ds-test',
    threadId: 'thread-1',
    manifestRevision: 1,
    references: []
  })

  const snapshot = buildJobSnapshot({
    session,
    plan,
    abilities: [{ abilityCode: 'general-implementation', recommendedCoreCode: 'codex' }],
    manifest
  })

  assert.equal(snapshot.designSessionId, 'ds-test')
  assert.equal(snapshot.draftRevision, 2)
  assert.equal(snapshot.planRevision, 1)
  assert.equal(snapshot.manifestRevision, 1)
  assert.equal(snapshot.workspaceRoot, '/workspace/project')
  assert.equal(snapshot.executionPlan.tasks.length, 1)
})

test('validateLaunchPreconditions checks resolved paths exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm5-launch-'))
  const missingPath = join(dir, 'missing.txt')

  try {
    const plan = samplePlan()
    plan.tasks[0]!.referenceIds = ['ref-missing']
    const missingManifest = buildJobReferenceManifest({
      jobId: 'ds-test',
      threadId: 'thread-1',
      references: [
        {
          id: 'ref-missing',
          name: 'gone',
          kind: 'file',
          mimeType: 'text/plain',
          description: 'missing',
          resolvedPath: missingPath,
          source: 'local_corpus',
          inWorkspace: false,
          requiresDescription: true,
          assetUrl: ''
        }
      ]
    })

    assert.throws(
      () =>
        validateLaunchPreconditions({
          session: sampleSession(),
          plan,
          manifest: missingManifest
        }),
      ReferenceFileMissingError
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
