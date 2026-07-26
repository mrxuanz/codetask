import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FileSystemDraftAssetStore } from '../../../src/server/adapters/fs'
import { openKernelDatabase, SqliteUnitOfWork } from '../../../src/server/adapters/sqlite'
import { ConversationService } from '../../../src/server/core/application/conversation'
import { DraftService } from '../../../src/server/core/application/draft'
import {
  DraftError,
  parseExecutionTree,
  type ExecutionTree
} from '../../../src/server/core/domain/draft'

function validTree(attachmentId: string): ExecutionTree {
  return {
    schemaVersion: 1,
    title: 'Delivery plan',
    summary: 'A small, ordered plan.',
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        objective: 'Land the core behavior.',
        successCriteria: 'The requested behavior is represented by focused units.',
        slices: [
          {
            id: 'm1-s1',
            title: 'Persistence',
            objective: 'Add durable state.',
            successCriteria: 'State survives a restart.',
            dependsOn: [],
            tasks: [
              {
                id: 'm1-s1-t1',
                title: 'Add schema',
                objective: 'Create the narrow persistence schema.',
                kind: 'data-modeling',
                estimatedMinutes: 10,
                files: ['src/server/schema.ts'],
                dependsOn: [],
                acceptanceCriteria: ['The schema exposes the required records.'],
                attachmentIds: [attachmentId]
              }
            ]
          },
          {
            id: 'm1-s2',
            title: 'Interface',
            objective: 'Expose the persisted state.',
            successCriteria: 'The interface reads the canonical state.',
            dependsOn: ['m1-s1'],
            tasks: [
              {
                id: 'm1-s2-t1',
                title: 'Add API',
                objective: 'Expose a typed endpoint.',
                kind: 'backend-implementation',
                estimatedMinutes: 12,
                files: ['src/server/routes/example.ts'],
                dependsOn: ['m1-s1-t1'],
                acceptanceCriteria: ['The endpoint returns the persisted representation.'],
                attachmentIds: []
              }
            ]
          }
        ]
      }
    ]
  }
}

function fixture(): {
  root: string
  database: ReturnType<typeof openKernelDatabase>
  conversation: ConversationService
  drafts: DraftService
  assets: FileSystemDraftAssetStore
  workspace: ReturnType<ConversationService['createWorkspace']>
} {
  const root = mkdtempSync(join(tmpdir(), 'codetask-draft-service-'))
  const database = openKernelDatabase({ filename: ':memory:' })
  database.client
    .prepare(
      `INSERT INTO auth_users
         (id, singleton_key, username, normalized_username, password_hash,
          password_version, created_at_ms, updated_at_ms)
       VALUES ('user-1', 1, 'Alice', 'alice', 'hash', 1, 1, 1)`
    )
    .run()
  let now = 100
  let id = 0
  const dependencies = {
    unitOfWork: new SqliteUnitOfWork(database),
    clock: { nowMs: () => now++ },
    ids: { generate: () => `id-${++id}` }
  }
  const conversation = new ConversationService(dependencies)
  const assets = new FileSystemDraftAssetStore(
    join(root, 'draft-assets'),
    join(root, 'job-intake-assets')
  )
  const drafts = new DraftService({ ...dependencies, assets })
  const workspace = conversation.createWorkspace('user-1', {
    rootPath: join(root, 'workspace'),
    canonicalKey: join(root, 'workspace'),
    title: 'Workspace'
  })
  return { root, database, conversation, drafts, assets, workspace }
}

describe('draft planning and Job intake boundary', () => {
  it('snapshots settings and keeps submitted attachments after draft deletion', async () => {
    const f = fixture()
    try {
      const configured = f.drafts.updateSettings('user-1', {
        model: 'auto',
        plannerPrompt: 'Custom planner',
        skillsManual: 'Custom manual',
        expectedRevision: 0
      })
      assert.equal(configured.revision, 1)

      let draft = f.drafts.createDraft('user-1', {
        workspaceId: f.workspace.id,
        title: 'Build feature',
        objective: 'Build one safe feature.',
        requirements: 'Persist state and expose it.',
        constraints: 'Do not use environment variables.',
        acceptanceCriteria: 'The state and API are covered.'
      })
      const uploaded = await f.drafts.addAttachment('user-1', draft.id, {
        expectedRevision: draft.revision,
        displayName: 'reference.txt',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode('reference body')
      })
      draft = uploaded.draft
      const generation = f.drafts.beginGeneration('user-1', draft.id)
      assert.equal(generation.plannerPrompt, 'Custom planner')
      assert.equal(generation.skillsManual, 'Custom manual')
      const tree = validTree(uploaded.attachment.id)
      const treeRecord = f.drafts.completeGeneration('user-1', draft.id, generation.run.id, tree, {
        plannerPrompt: generation.plannerPrompt,
        skillsManual: generation.skillsManual
      })

      const handoff = await f.drafts.confirmExecutionTree('user-1', draft.id, {
        expectedRevision: draft.revision,
        treeId: treeRecord.id
      })
      assert.equal(handoff.state, 'pending')
      assert.equal(handoff.attachmentCount, 1)
      assert.equal(handoff.jobModuleImplemented, true)
      const repeated = await f.drafts.confirmExecutionTree('user-1', draft.id, {
        expectedRevision: draft.revision,
        treeId: treeRecord.id
      })
      assert.equal(repeated.id, handoff.id)
      await assert.rejects(
        () =>
          f.drafts.confirmExecutionTree('other-user', draft.id, {
            expectedRevision: draft.revision,
            treeId: treeRecord.id
          }),
        (error: unknown) => error instanceof DraftError && error.code === 'draft.not_found'
      )

      const intakeAttachment = f.database.client
        .prepare(`SELECT storage_relative_path FROM job_intake_attachments WHERE handoff_id = ?`)
        .get(handoff.id) as { storage_relative_path: string }
      const intakePath = join(f.root, 'job-intake-assets', intakeAttachment.storage_relative_path)
      assert.equal(existsSync(intakePath), true)

      await f.drafts.deleteDraft('user-1', draft.id)
      assert.deepEqual(f.database.client.prepare(`SELECT COUNT(*) AS n FROM drafts`).get(), {
        n: 0
      })
      assert.deepEqual(
        f.database.client.prepare(`SELECT COUNT(*) AS n FROM job_intake_handoffs`).get(),
        { n: 1 }
      )
      assert.equal(existsSync(intakePath), true)
      assert.equal(existsSync(join(f.root, 'draft-assets', draft.id)), false)
    } finally {
      f.database.close()
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('rejects forward dependencies, host paths and unknown attachments', () => {
    const tree = validTree('attachment-1')
    assert.deepEqual(parseExecutionTree(JSON.stringify(tree), new Set(['attachment-1'])), tree)

    const forward = structuredClone(tree)
    forward.milestones[0]!.slices[0]!.tasks[0]!.dependsOn = ['m1-s2-t1']
    assert.throws(
      () => parseExecutionTree(JSON.stringify(forward), new Set(['attachment-1'])),
      (error: unknown) =>
        error instanceof DraftError && error.code === 'draft.tree_invalid_dependency'
    )

    const absolute = structuredClone(tree)
    absolute.milestones[0]!.slices[0]!.tasks[0]!.files = ['/etc/passwd']
    assert.throws(
      () => parseExecutionTree(JSON.stringify(absolute), new Set(['attachment-1'])),
      (error: unknown) => error instanceof DraftError && error.code === 'draft.tree_invalid_path'
    )

    assert.throws(
      () => parseExecutionTree(JSON.stringify(tree), new Set()),
      (error: unknown) =>
        error instanceof DraftError && error.code === 'draft.tree_unknown_attachment'
    )
  })
})
