import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'node:test'
import { Hono } from 'hono'
import { createUserJobRoutes, createJobRoutes } from '../../../src/server/routes/jobs'
import { createDesignSessionRoutes } from '../../../src/server/routes/design-sessions'
import type { AppContext } from '../../../src/server/context'
import {
  resetSchemaGeneration,
  setSchemaGeneration
} from '../../../src/server/application/cutover-schema-generation'

const noopCtx = {} as AppContext

const USER_JOB_WRITE_ROUTES = [
  { method: 'POST', path: '/jobs/queue/resume' },
  { method: 'POST', path: '/jobs/job-1/pause' },
  { method: 'POST', path: '/jobs/job-1/resume' },
  { method: 'POST', path: '/jobs/job-1/continue' },
  { method: 'POST', path: '/jobs/job-1/cancel' },
  { method: 'POST', path: '/jobs/job-1/restart' },
  { method: 'POST', path: '/jobs/job-1/retry-planning' },
  { method: 'DELETE', path: '/jobs/job-1' }
] as const

const THREAD_JOB_WRITE_ROUTES = [
  { method: 'POST', path: '/threads/thread-1/jobs/job-1/confirm-plan' },
  { method: 'PATCH', path: '/threads/thread-1/jobs/job-1/plan' },
  { method: 'POST', path: '/threads/thread-1/jobs' },
  { method: 'POST', path: '/threads/thread-1/jobs/job-1/plan/nodes/node-1/confirm' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/confirm' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/confirm-final' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/unlock' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/unlock-contract' },
  { method: 'PATCH', path: '/threads/thread-1/messages/message-1/draft' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/sections/abilities/confirm' },
  { method: 'PATCH', path: '/threads/thread-1/messages/message-1/draft/abilities' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/references' },
  { method: 'DELETE', path: '/threads/thread-1/messages/message-1/draft/references/ref-1' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/references/import' },
  { method: 'POST', path: '/threads/thread-1/messages/message-1/draft/references/local-corpus' },
  { method: 'PATCH', path: '/threads/thread-1/messages/message-1/draft/references/ref-1' }
] as const

const DESIGN_SESSION_WRITE_ROUTES = [
  { method: 'POST', path: '/threads/thread-1/design-sessions/session-1/references/attachment' },
  { method: 'POST', path: '/threads/thread-1/design-sessions/session-1/references/local-corpus' },
  { method: 'PATCH', path: '/threads/thread-1/design-sessions/session-1/references/ref-1' },
  { method: 'DELETE', path: '/threads/thread-1/design-sessions/session-1/references/ref-1' },
  { method: 'POST', path: '/threads/thread-1/design-sessions/session-1/references/freeze' },
  { method: 'POST', path: '/threads/thread-1/design-sessions/session-1/launch' }
] as const

async function assertAllBlocked(
  app: Hono,
  routes: ReadonlyArray<{ readonly method: string; readonly path: string }>
): Promise<void> {
  for (const route of routes) {
    let response: Response
    try {
      const init: RequestInit = {
        method: route.method,
        headers: { 'content-type': 'application/json' }
      }
      if (route.method === 'PATCH' || route.method === 'POST') {
        init.body = JSON.stringify({ plan: {} })
      }
      response = await app.request(route.path, init)
    } catch {
      assert.fail(
        `${route.method} ${route.path} must return 410 or remain unmounted under authoritative`
      )
    }
    assert.equal(
      response.status,
      410,
      `${route.method} ${route.path} must return 410 under authoritative`
    )
  }
}

describe('composition: authoritative legacy job routes (D07)', () => {
  afterEach(() => {
    resetSchemaGeneration()
  })

  it('blocks /jobs legacy writers with 410 when authoritative', async () => {
    setSchemaGeneration('v3_authoritative')
    const app = new Hono()
    app.route('/jobs', createUserJobRoutes(noopCtx))
    await assertAllBlocked(app, USER_JOB_WRITE_ROUTES)
  })

  it('blocks thread-scoped legacy job writers with 410 when authoritative', async () => {
    setSchemaGeneration('v3_authoritative')
    const app = new Hono()
    app.route('/threads', createJobRoutes(noopCtx))
    await assertAllBlocked(app, THREAD_JOB_WRITE_ROUTES)
  })

  it('blocks design-session legacy writers with 410 when authoritative', async () => {
    setSchemaGeneration('v3_authoritative')
    const app = new Hono()
    app.route('/threads', createDesignSessionRoutes(noopCtx))
    await assertAllBlocked(app, DESIGN_SESSION_WRITE_ROUTES)
  })
})
