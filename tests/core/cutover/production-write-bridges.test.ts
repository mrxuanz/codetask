import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { setupAccount } from '../../../src/server/auth/service.ts'
import {
  createApplication,
  type ApplicationHandle
} from '../../../src/server/composition/index.ts'
import type { AppContext } from '../../../src/server/context/types.ts'
import {
  asProjectId,
  asThreadId,
  asUserId,
  createThread
} from '../../../src/server/core/domain/conversation/index.ts'
import { asDraftId } from '../../../src/server/core/domain/drafts/types.ts'
import {
  asPlanId,
  asPlanNodeId,
  asPlanRevision
} from '../../../src/server/core/domain/plans/types.ts'
import { closeDatabaseForTests, initDb } from '../../../src/server/db/index.ts'
import { toErrorHttpResult } from '../../../src/server/error.ts'
import { createDraftListRoutes } from '../../../src/server/routes/drafts.ts'
import { createPlanRoutes } from '../../../src/server/routes/plans.ts'

function mountWithErrors(routeBase: string, routes: Hono): Hono {
  const app = new Hono()
  app.onError((error, c) => {
    const { body, status } = toErrorHttpResult(error)
    return c.json(body, status as ContentfulStatusCode)
  })
  app.route(routeBase, routes)
  return app
}

describe('production write bridges (draft confirm + plan create/confirm)', () => {
  let core: ApplicationHandle | null = null
  let dataDir = ''

  afterEach(() => {
    core?.close()
    core = null
    closeDatabaseForTests()
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true })
      dataDir = ''
    }
  })

  async function bootSqliteCore(): Promise<{ token: string; ctx: AppContext }> {
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-prod-write-'))
    initDb(dataDir)
    const auth = await setupAccount('writeuser', 'WriteUser1!')
    core = createApplication({
      mode: 'sqlite',
      sqlitePath: join(dataDir, 'kernel.sqlite')
    })
    await core.threads.save(
      createThread({
        id: asThreadId('t1'),
        projectId: asProjectId('p1'),
        ownerUserId: asUserId('writeuser')
      })
    )
    return { token: auth.token, ctx: { coreApplication: core } as AppContext }
  }

  it('POST /drafts/:draftId/confirm confirms collecting draft', async () => {
    const { token, ctx } = await bootSqliteCore()
    await core!.drafts.save({
      id: asDraftId('write-draft-1'),
      status: 'collecting',
      revision: 0,
      content: 'write confirm hello',
      projectId: 'p1',
      threadId: 't1'
    })

    const app = mountWithErrors('/drafts', createDraftListRoutes(ctx))
    const res = await app.request('/drafts/write-draft-1/confirm', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { draft: { draftId: string; status: string; collecting: boolean } }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.draft.draftId, 'write-draft-1')
    // Legacy mapper: domain `confirmed` → `ready`
    assert.equal(body.data.draft.status, 'ready')
    assert.equal(body.data.draft.collecting, false)

    const stored = await core!.drafts.get('write-draft-1')
    assert.equal(stored?.status, 'confirmed')
  })

  it('POST /plans/:planId/confirm confirms in_review plan', async () => {
    const { token, ctx } = await bootSqliteCore()
    await core!.plans.save({
      id: asPlanId('write-plan-1'),
      revision: asPlanRevision(1),
      // Domain confirm requires in_review (legacy maps both editing/in_review → plan_editing).
      status: 'in_review',
      threadId: 't1',
      draftId: 'd1',
      executionGeneration: 0,
      nodes: [
        {
          id: asPlanNodeId('m1'),
          kind: 'milestone',
          title: 'Write milestone',
          parentId: null
        },
        {
          id: asPlanNodeId('s1'),
          kind: 'slice',
          title: 'Write slice',
          parentId: asPlanNodeId('m1')
        },
        {
          id: asPlanNodeId('t1'),
          kind: 'task',
          title: 'Write task',
          parentId: asPlanNodeId('s1')
        }
      ],
      edges: []
    })

    const app = mountWithErrors('/plans', createPlanRoutes(ctx))
    const res = await app.request('/plans/write-plan-1/confirm', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { plan: { id: string; status: string; planConfirmedAt: number | null } }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.plan.id, 'write-plan-1')
    // Legacy mapper: domain `confirmed` → `pending`
    assert.equal(body.data.plan.status, 'pending')
    assert.equal(body.data.plan.planConfirmedAt, 1)

    const stored = await core!.plans.get('write-plan-1')
    assert.equal(stored?.status, 'confirmed')
  })

  it('POST /plans creates plan with threadId and is gettable', async () => {
    const { token, ctx } = await bootSqliteCore()
    const app = mountWithErrors('/plans', createPlanRoutes(ctx))

    const createRes = await app.request('/plans', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'write-create-plan-1'
      },
      body: JSON.stringify({ threadId: 't1', draftId: 'd-create-1' })
    })
    assert.equal(createRes.status, 200)
    const created = (await createRes.json()) as {
      success: boolean
      data: { plan: { id: string; status: string } }
    }
    assert.equal(created.success, true)
    assert.ok(created.data.plan.id)
    assert.equal(created.data.plan.status, 'plan_editing')

    const planId = created.data.plan.id
    const getRes = await app.request(`/plans/${planId}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.equal(getRes.status, 200)
    const got = (await getRes.json()) as {
      success: boolean
      data: { plan: { id: string } }
    }
    assert.equal(got.success, true)
    assert.equal(got.data.plan.id, planId)

    const stored = await core!.plans.get(planId)
    assert.ok(stored)
    assert.equal(stored.threadId, 't1')
    assert.equal(stored.draftId, 'd-create-1')
    assert.equal(stored.status, 'editing')
  })
})
