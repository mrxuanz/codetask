import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')

describe('conversation mode resolution (03)', () => {
  it('turn enqueue API rejects create_task / draft kinds', () => {
    const routes = readFileSync(
      join(root, 'packages/server-core/src/modules/conversation/http/conversation-routes.ts'),
      'utf8'
    )
    assert.match(routes, /Draft\/Plan fields are not accepted/)
  })

  it('legacy threads route file is gone; stub returns conversation.moved', () => {
    assert.equal(existsSync(join(root, 'src/server/routes/threads.ts')), false)
    const api = readFileSync(join(root, 'src/server/routes/api.ts'), 'utf8')
    assert.match(api, /createRemovedThreadsStub|conversation\.moved/)
  })
})
