/**
 * Legacy threads-table wizard context tests retired in architecture 03.
 * Conversation owns /api/conversations; Design owns drafts/planning.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

describe('threads suite retirement (03)', () => {
  it('host threads service and wizard residuals are removed', () => {
    assert.equal(existsSync(join(root, 'src/server/threads')), false)
    assert.equal(existsSync(join(root, 'src/server/legacy-wizard')), false)
    assert.equal(existsSync(join(root, 'src/server/legacy-draft')), false)
    assert.equal(existsSync(join(root, 'tests/threads/update-thread-context-phase.test.ts')), false)
  })
})
