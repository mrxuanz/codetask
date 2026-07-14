import assert from 'node:assert/strict'
import { describe, it, afterEach } from 'node:test'
import { Hono } from 'hono'
import { createUserJobRoutes, createJobRoutes } from '../../../src/server/routes/jobs'
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
  { method: 'POST', path: '/threads/thread-1/jobs' }
] as const

describe('composition: authoritative legacy job routes (D07)', () => {
  afterEach(() => {
    resetSchemaGeneration()
  })

  it('blocks /jobs legacy writers with 410 when authoritative', async () => {
    setSchemaGeneration('v3_authoritative')
    const app = new Hono()
    app.route('/jobs', createUserJobRoutes(noopCtx))

    for (const route of USER_JOB_WRITE_ROUTES) {
      const response = await app.request(route.path, { method: route.method })
      assert.equal(
        response.status,
        410,
        `${route.method} ${route.path} must return 410 under authoritative`
      )
    }
  })

  it('blocks thread-scoped legacy job writers with 410 when authoritative', async () => {
    setSchemaGeneration('v3_authoritative')
    const app = new Hono()
    app.route('/threads', createJobRoutes(noopCtx))

    for (const route of THREAD_JOB_WRITE_ROUTES) {
      let response: Response
      try {
        const init: RequestInit = {
          method: route.method,
          headers: { 'content-type': 'application/json' }
        }
        if (route.method === 'PATCH') {
          init.body = JSON.stringify({ plan: {} })
        }
        response = await app.request(route.path, init)
      } catch {
        // Handler may throw before guard on unprotected routes; treat as not blocked.
        assert.fail(`${route.method} ${route.path} must return 410 or remain unmounted under authoritative`)
      }
      assert.equal(
        response.status,
        410,
        `${route.method} ${route.path} must return 410 or remain unmounted under authoritative`
      )
    }
  })
})
