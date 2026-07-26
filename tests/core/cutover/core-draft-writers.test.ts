import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  createApplication,
  tryCoreDraftConfirmFinal,
  tryCoreDraftPatch,
  tryCoreDraftSectionConfirm,
  tryCoreDraftUnlock,
  type ApplicationHandle
} from '../../../src/server/composition/index.ts'
import { asDraftId, confirmDraft } from '../../../src/server/core/domain/drafts/index.ts'
import { createDraft } from '../../../src/server/core/domain/drafts/transitions.ts'

describe('core draft writer bridges', () => {
  let core: ApplicationHandle | null = null

  afterEach(() => {
    core?.close()
    core = null
  })

  it('tryCoreDraftPatch updates collecting draft payload', async () => {
    core = createApplication({ mode: 'memory' })
    await core.drafts.save(
      createDraft({
        id: asDraftId('bridge-patch-1'),
        projectId: 'p1',
        threadId: 't1',
        content: 'hello'
      })
    )

    const app = new Hono()
    app.patch('/:draftId', async (c) => {
      const r = await tryCoreDraftPatch(c, c.req.param('draftId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-patch-1', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer u1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: 'patched',
        payload: { wizardPhase: 'draft_review' }
      })
    })
    assert.equal(res.status, 200)
    const stored = await core!.drafts.get('bridge-patch-1')
    assert.equal(stored?.content, 'patched')
    assert.equal(stored?.payload?.wizardPhase, 'draft_review')
  })

  it('tryCoreDraftSectionConfirm locks section', async () => {
    core = createApplication({ mode: 'memory' })
    await core.drafts.save(
      createDraft({
        id: asDraftId('bridge-sec-1'),
        projectId: 'p1',
        threadId: 't1'
      })
    )

    const app = new Hono()
    app.post('/:draftId/:section', async (c) => {
      const r = await tryCoreDraftSectionConfirm(
        c,
        c.req.param('draftId'),
        c.req.param('section'),
        core!
      )
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-sec-1/acceptance', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer u1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 200)
    const stored = await core!.drafts.get('bridge-sec-1')
    assert.equal(stored?.payload?.sections?.acceptance?.locked, true)
  })

  it('tryCoreDraftUnlock confirmed → collecting', async () => {
    core = createApplication({ mode: 'memory' })
    const confirmed = confirmDraft(
      createDraft({
        id: asDraftId('bridge-unlock-1'),
        projectId: 'p1',
        threadId: 't1',
        payload: { planId: 'plan-x' }
      })
    )
    await core.drafts.save(confirmed)

    const app = new Hono()
    app.post('/:draftId', async (c) => {
      const r = await tryCoreDraftUnlock(c, c.req.param('draftId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-unlock-1', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer u1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 200)
    const stored = await core!.drafts.get('bridge-unlock-1')
    assert.equal(stored?.status, 'collecting')
    assert.equal(stored?.payload?.planId, null)
  })

  it('tryCoreDraftConfirmFinal confirms and creates queued job', async () => {
    core = createApplication({ mode: 'memory' })
    await core.drafts.save(
      createDraft({
        id: asDraftId('bridge-final-1'),
        projectId: 'p1',
        threadId: 't1',
        content: 'final'
      })
    )

    const app = new Hono()
    app.post('/:draftId', async (c) => {
      const r = await tryCoreDraftConfirmFinal(c, c.req.param('draftId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-final-1', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer u1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { draft: { draftId: string }; job: { id: string; status: string } }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.draft.draftId, 'bridge-final-1')
    assert.equal(body.data.job.status, 'queued')

    const stored = await core!.drafts.get('bridge-final-1')
    assert.equal(stored?.status, 'confirmed')
    assert.equal(stored?.payload?.jobId, body.data.job.id)
  })

  it('tryCoreDraftConfirmFinal returns null when draft missing', async () => {
    core = createApplication({ mode: 'memory' })
    const app = new Hono()
    app.post('/:draftId', async (c) => {
      const r = await tryCoreDraftConfirmFinal(c, 'missing', core!)
      return c.json({ bridged: r !== null })
    })
    const res = await app.request('/missing', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer u1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
    const body = (await res.json()) as { bridged: boolean }
    assert.equal(body.bridged, false)
  })
})
