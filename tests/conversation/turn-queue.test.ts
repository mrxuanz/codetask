import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

describe('legacy turn-queue removed (03)', () => {
  it('src/server/conversation/turn-queue.ts is deleted', () => {
    assert.equal(existsSync(join(root, 'src/server/conversation/turn-queue.ts')), false)
  })

  it('unmounted thread/turn route files are deleted', () => {
    assert.equal(existsSync(join(root, 'src/server/routes/threads.ts')), false)
    assert.equal(existsSync(join(root, 'src/server/routes/turns.ts')), false)
    assert.equal(existsSync(join(root, 'src/server/routes/conversation.ts')), false)
  })
})
