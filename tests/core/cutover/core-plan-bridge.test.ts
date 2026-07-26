import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  createApplication,
  tryCorePlanGet,
  type ApplicationHandle
} from '../../../src/server/composition/index.ts'
import {
  asPlanId,
  asPlanNodeId,
  asPlanRevision
} from '../../../src/server/core/domain/plans/types.ts'

describe('core plan get bridge', () => {
  let core: ApplicationHandle | null = null

  afterEach(() => {
    core?.close()
    core = null
  })

  it('tryCorePlanGet returns plan present in core', async () => {
    core = createApplication({ mode: 'memory' })
    await core.plans.save({
      id: asPlanId('bridge-plan-1'),
      revision: asPlanRevision(0),
      status: 'editing',
      threadId: 't1',
      draftId: 'd1',
      executionGeneration: 0,
      nodes: [
        {
          id: asPlanNodeId('m1'),
          kind: 'milestone',
          title: 'Bridge milestone',
          parentId: null
        },
        {
          id: asPlanNodeId('t1'),
          kind: 'task',
          title: 'Bridge task',
          parentId: asPlanNodeId('m1')
        }
      ],
      edges: []
    })

    const app = new Hono()
    app.get('/:planId', async (c) => {
      const r = await tryCorePlanGet(c, c.req.param('planId'), core!)
      if (!r) return c.json({ bridged: false }, 500)
      return r
    })

    const res = await app.request('/bridge-plan-1', {
      headers: { Authorization: 'Bearer u1' }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: {
        plan: {
          id: string
          title: string
          status: string
          planRevision: number
          nodes: readonly { nodeRef: string; title: string }[]
        }
      }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.plan.id, 'bridge-plan-1')
    assert.equal(body.data.plan.title, 'Bridge milestone')
    assert.equal(body.data.plan.status, 'plan_editing')
    assert.equal(body.data.plan.planRevision, 0)
    assert.equal(body.data.plan.nodes.length, 1)
    assert.equal(body.data.plan.nodes[0]?.nodeRef, 'task:t1')
  })

  it('tryCorePlanGet returns null when plan missing in core', async () => {
    core = createApplication({ mode: 'memory' })
    const app = new Hono()
    app.get('/:planId', async (c) => {
      const r = await tryCorePlanGet(c, 'missing-plan', core!)
      return c.json({ bridged: r !== null })
    })
    const res = await app.request('/missing-plan', {
      headers: { Authorization: 'Bearer u1' }
    })
    const body = (await res.json()) as { bridged: boolean }
    assert.equal(body.bridged, false)
  })
})
