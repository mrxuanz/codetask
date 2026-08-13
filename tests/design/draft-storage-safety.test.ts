import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { MAX_DRAFT_LIST_ITEMS, MAX_NODE_DESCRIPTION_CHARS } from '@codetask/contracts'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { DraftApplication } from '../../packages/server-core/src/modules/design/draft/application/draft-application.ts'
import type {
  DraftRepository,
  ProjectWorkspacePort
} from '../../packages/server-core/src/modules/design/draft/application/ports.ts'
import type { DraftRecord } from '../../packages/server-core/src/modules/design/draft/domain/draft.ts'
import { SqliteDraftRepository } from '../../packages/server-core/src/modules/design/draft/infrastructure/sqlite-draft-repository.ts'
import { DesignValidationError } from '../../packages/server-core/src/modules/design/shared.ts'

function draftRecord(): DraftRecord {
  return {
    id: 'draft-storage-test',
    actorId: 'alice',
    projectId: 'project-1',
    title: 'Draft',
    summary: '',
    userFlow: '',
    techStack: '',
    nfr: [],
    acceptance: [],
    verification: [],
    outOfScope: [],
    assumptions: [],
    requirementsMarkdown: '# Requirements',
    requirementsStatus: 'pending',
    lockedSections: {},
    executionProfile: null,
    workspaceRoot: '/tmp/project-1',
    status: 'editing',
    lockRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    abilities: [],
    references: []
  }
}

test('draft application rejects an aggregate multi-megabyte record before SQLite insert', async () => {
  let inserted = false
  const drafts = {
    async insert() {
      inserted = true
    }
  } as unknown as DraftRepository
  const projects: ProjectWorkspacePort = {
    async resolveWorkspaceRoot() {
      return '/tmp/project-1'
    }
  }
  const application = new DraftApplication(drafts, projects)

  await assert.rejects(
    () =>
      application.create(
        { userId: 'alice', sessionId: 'draft-storage' },
        {
          projectId: 'project-1',
          title: 'Large draft',
          nfr: Array.from({ length: MAX_DRAFT_LIST_ITEMS }, () =>
            'x'.repeat(MAX_NODE_DESCRIPTION_CHARS)
          )
        }
      ),
    (error: unknown) => error instanceof DesignValidationError && /bytes/.test(error.message)
  )
  assert.equal(inserted, false)
})

test('stale reference revision rolls back both draft and reference rows', async () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migration043DesignModuleTables.up(db)
  const repository = new SqliteDraftRepository(db)
  const current = draftRecord()
  await repository.insert(current)
  const next: DraftRecord = {
    ...current,
    lockRevision: 1,
    updatedAt: 2,
    references: [
      {
        id: 'reference-1',
        name: 'Reference',
        kind: 'file',
        description: 'Must remain atomic'
      }
    ]
  }

  await assert.rejects(() => repository.updateReferences(next, 99, next.references))
  const row = db
    .prepare(`SELECT lock_revision AS revision FROM drafts WHERE id = ?`)
    .get(current.id) as {
    revision: number
  }
  const referenceCount = db
    .prepare(`SELECT COUNT(*) AS count FROM design_draft_references WHERE draft_id = ?`)
    .get(current.id) as { count: number }
  assert.equal(row.revision, 0)
  assert.equal(referenceCount.count, 0)
  db.close()
})

test('deleting a draft clears stale reference metadata and releases its assets', async () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migration043DesignModuleTables.up(db)
  const repository = new SqliteDraftRepository(db)
  const current = draftRecord()
  await repository.insert(current)
  const reference = {
    id: 'reference-delete',
    name: 'Delete me',
    kind: 'file' as const,
    description: 'Unpublished attachment'
  }
  await repository.updateReferences(
    { ...current, references: [reference], lockRevision: 1, updatedAt: 2 },
    0,
    [reference]
  )
  const released: string[] = []
  const application = new DraftApplication(
    repository,
    {
      async resolveWorkspaceRoot() {
        return '/tmp/project-1'
      }
    },
    {
      prepareReference({ reference: prepared }) {
        return prepared
      },
      retainReference(draftId) {
        void draftId
      },
      releaseReference(draftId) {
        void draftId
      },
      releaseDraft(draftId) {
        released.push(draftId)
      }
    }
  )

  await application.archive({ userId: 'alice', sessionId: 'delete-draft' }, current.id)

  const archived = await repository.getById(current.id)
  assert.equal(archived?.status, 'archived')
  assert.deepEqual(archived?.references, [])
  assert.deepEqual(released, [current.id])
  db.close()
})
