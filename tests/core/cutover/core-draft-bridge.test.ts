import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  createApplication,
  tryCoreDraftGet,
  type ApplicationHandle
} from '../../../src/server/composition/index.ts'
import { asDraftId } from '../../../src/server/core/domain/drafts/types.ts'

describe('core draft get bridge', () => {
  let core: ApplicationHandle | null = null

  afterEach(() => {
    core?.close()
    core = null
  })

  it('tryCoreDraftGet returns draft present in core', async () => {
    core = createApplication({ mode: 'memory' })
    await core.drafts.save({
      id: asDraftId('bridge-draft-1'),
      status: 'collecting',
      revision: 0,
      content: 'hello',
      projectId: 'p1',
      threadId: 't1'
    })

    const app = new Hono()
    app.get('/:draftId', async (c) => {
      const r = await tryCoreDraftGet(c, c.req.param('draftId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-draft-1', {
      headers: { Authorization: 'Bearer u1' }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { draft: { draftId: string; summary: string } }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.draft.draftId, 'bridge-draft-1')
    assert.equal(body.data.draft.summary, 'hello')
  })

  it('tryCoreDraftGet returns null when draft missing in core', async () => {
    core = createApplication({ mode: 'memory' })
    const app = new Hono()
    app.get('/:draftId', async (c) => {
      const r = await tryCoreDraftGet(c, 'missing-draft', core!)
      return c.json({ bridged: r !== null })
    })
    const res = await app.request('/missing-draft', {
      headers: { Authorization: 'Bearer u1' }
    })
    const body = (await res.json()) as { bridged: boolean }
    assert.equal(body.bridged, false)
  })
})
