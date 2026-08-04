/**
 * Architecture residual DoD — M1 easy residuals.
 * @see docs/架构收口/残差进度.md
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

describe('architecture residual DoD — M1', () => {
  it('wizard turn-error codes are gone', () => {
    const codes = readFileSync(join(root, 'src/shared/turn-errors/codes.ts'), 'utf8')
    const zh = readFileSync(join(root, 'src/shared/turn-errors/i18n-zh.ts'), 'utf8')
    const ja = readFileSync(join(root, 'src/shared/turn-errors/i18n-ja.ts'), 'utf8')
    for (const text of [codes, zh, ja]) {
      assert.doesNotMatch(text, /thread\.wizard\./)
      assert.doesNotMatch(text, /'wizard\./)
    }
  })

  it('deletion_requests owner column is actor_id', () => {
    const schema = readFileSync(join(root, 'src/server/db/schema.ts'), 'utf8')
    assert.match(schema, /export const deletionRequests[\s\S]*?actorId:\s*text\('actor_id'\)/)
    assert.doesNotMatch(
      schema,
      /export const deletionRequests[\s\S]*?username:\s*text\('username'\)/
    )

    const coordinator = readFileSync(join(root, 'src/server/infra/deletion-coordinator.ts'), 'utf8')
    assert.match(coordinator, /actorId:\s*string/)
    assert.match(coordinator, /actorId:\s*row\.actorId/)
    assert.doesNotMatch(coordinator, /username:\s*row\.username/)
    assert.doesNotMatch(coordinator, /deletionRequests[\s\S]{0,80}username/)

    const migration = readFileSync(
      join(root, 'packages/database/src/migrations/deletion-requests-actor-id.ts'),
      'utf8'
    )
    assert.match(migration, /version:\s*58/)
    assert.match(migration, /RENAME COLUMN username TO actor_id/)

    const index = readFileSync(join(root, 'src/server/db/migrations/index.ts'), 'utf8')
    assert.match(index, /migration058DeletionRequestsActorIdTables/)
  })

  it('TaskLaunchDraftPayload has a single shared definition', () => {
    const draftForm = readFileSync(join(root, 'apps/web/src/lib/draftForm.ts'), 'utf8')
    assert.doesNotMatch(draftForm, /export interface TaskLaunchDraftPayload/)
    assert.doesNotMatch(draftForm, /export interface TaskLaunchDraftAbility/)
    assert.match(draftForm, /from '@codetask\/contracts'/)

    const shared = readFileSync(join(root, 'packages/contracts/src/ui-draft.ts'), 'utf8')
    assert.match(shared, /export type TaskLaunchDraftPayload/)
  })
})
