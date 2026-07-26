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

describe('production get-by-id routes (plan + draft)', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'codetask-prod-get-'))
    initDb(dataDir)
    const auth = await setupAccount('planuser', 'PlanUser1!')
    core = createApplication({
      mode: 'sqlite',
      sqlitePath: join(dataDir, 'kernel.sqlite')
    })
    await core.threads.save(
      createThread({
        id: asThreadId('t1'),
        projectId: asProjectId('p1'),
        ownerUserId: asUserId('planuser')
      })
    )
    return { token: auth.token, ctx: { coreApplication: core } as AppContext }
  }

  it('GET /plans/:planId returns seeded sqlite plan via tryCorePlanGet', async () => {
    const { token, ctx } = await bootSqliteCore()
    await core!.plans.save({
      id: asPlanId('prod-plan-1'),
      revision: asPlanRevision(0),
      status: 'editing',
      threadId: 't1',
      draftId: 'd1',
      executionGeneration: 0,
      nodes: [
        {
          id: asPlanNodeId('m1'),
          kind: 'milestone',
          title: 'Prod milestone',
          parentId: null
        },
        {
          id: asPlanNodeId('t1'),
          kind: 'task',
          title: 'Prod task',
          parentId: asPlanNodeId('m1')
        }
      ],
      edges: []
    })

    const app = mountWithErrors('/plans', createPlanRoutes(ctx))
    const res = await app.request('/plans/prod-plan-1', {
      headers: { Authorization: `Bearer ${token}` }
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
    assert.equal(body.data.plan.id, 'prod-plan-1')
    assert.equal(body.data.plan.title, 'Prod milestone')
    assert.equal(body.data.plan.status, 'plan_editing')
    assert.equal(body.data.plan.planRevision, 0)
    assert.equal(body.data.plan.nodes.length, 1)
    assert.equal(body.data.plan.nodes[0]?.nodeRef, 'task:t1')
  })

  it('GET /plans/:planId returns 404 when plan missing in core', async () => {
    const { token, ctx } = await bootSqliteCore()
    const app = mountWithErrors('/plans', createPlanRoutes(ctx))
    const res = await app.request('/plans/missing-plan', {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.equal(res.status, 404)
    const body = (await res.json()) as { success: boolean; message: string }
    assert.equal(body.success, false)
    assert.match(body.message, /Plan not found/i)
  })

  it('GET /drafts/:draftId returns seeded sqlite draft via tryCoreDraftGet', async () => {
    const { token, ctx } = await bootSqliteCore()
    await core!.drafts.save({
      id: asDraftId('prod-draft-1'),
      status: 'collecting',
      revision: 0,
      content: 'prod hello',
      projectId: 'p1',
      threadId: 't1'
    })

    const app = mountWithErrors('/drafts', createDraftListRoutes(ctx))
    const res = await app.request('/drafts/prod-draft-1', {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      success: boolean
      data: { draft: { draftId: string; summary: string } }
    }
    assert.equal(body.success, true)
    assert.equal(body.data.draft.draftId, 'prod-draft-1')
    assert.equal(body.data.draft.summary, 'prod hello')
  })

  it('GET /drafts/:draftId returns 404 when draft missing in core', async () => {
    const { token, ctx } = await bootSqliteCore()
    const app = mountWithErrors('/drafts', createDraftListRoutes(ctx))
    const res = await app.request('/drafts/missing-draft', {
      headers: { Authorization: `Bearer ${token}` }
    })
    assert.equal(res.status, 404)
    const body = (await res.json()) as { success: boolean; message: string }
    assert.equal(body.success, false)
    assert.match(body.message, /Draft not found/i)
  })
})
