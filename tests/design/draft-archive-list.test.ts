import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migration043DesignModuleTables } from '../../packages/database/src/migrations/index.ts'
import { SqliteDraftRepository } from '../../packages/server-core/src/modules/design/draft/infrastructure/sqlite-draft-repository.ts'
import { DraftApplication } from '../../packages/server-core/src/modules/design/draft/application/draft-application.ts'

test('draft archive excludes row from default list (completion=all)', async () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migration043DesignModuleTables.up(db)

  const repo = new SqliteDraftRepository(db)
  const drafts = new DraftApplication(repo, {
    resolveWorkspaceRoot: async () => '/tmp/draft-archive'
  })
  const actor = { userId: 'alice', sessionId: 's1' }

  const keep = await drafts.create(actor, {
    projectId: 'proj-1',
    title: 'Keep me',
    requirementsMarkdown: 'req'
  })
  const doomed = await drafts.create(actor, {
    projectId: 'proj-1',
    title: 'Archive me',
    requirementsMarkdown: 'req'
  })

  await drafts.archive(actor, doomed.id)

  const listed = await drafts.list(actor, { completion: 'all' })
  assert.equal(
    listed.some((d) => d.id === doomed.id),
    false
  )
  assert.equal(
    listed.some((d) => d.id === keep.id),
    true
  )

  const incomplete = await drafts.list(actor, { completion: 'incomplete' })
  assert.equal(
    incomplete.some((d) => d.id === doomed.id),
    false
  )
  assert.equal(
    incomplete.some((d) => d.id === keep.id),
    true
  )
})
