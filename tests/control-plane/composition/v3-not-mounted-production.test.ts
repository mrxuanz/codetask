/**
 * Phase C4: production createApiRoutes must not expose `/api/v3` as a parallel
 * authority. `/api/core` is the parallel new-core surface.
 *
 * Isolation tests that need a dedicated control HTTP surface should mount core routes and may set
 * `cutover_blocked` for blocked/410 scenarios — those are unaffected.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createApiRoutes } from '../../../src/server/routes/api'
import { setCutoverMarkerForTests } from '../../../src/server/application/cutover-state'
import { withCompositionContext } from './fixtures'

function routePathsInclude(api: ReturnType<typeof createApiRoutes>, needle: string): boolean {
  return api.routes.some((route) => {
    const path = typeof route.path === 'string' ? route.path : ''
    return path.includes(needle)
  })
}

describe('composition: V3 not mounted on production API (C4)', () => {
  afterEach(() => {
    setCutoverMarkerForTests(null)
  })

  it('boot without cutover_blocked does not mount /v3; /core remains', async () => {
    await withCompositionContext({ generation: 'copied' }, async (ctx) => {
      const api = createApiRoutes(ctx)
      assert.equal(
        routePathsInclude(api, '/v3'),
        false,
        'production API must not mount /v3 when marker is not authoritative'
      )
      assert.equal(
        routePathsInclude(api, '/core'),
        true,
        'production API must mount /core as the parallel new-core surface'
      )

      // Unauthenticated probe: /v3 must not resolve to a mounted V3 handler.
      const v3Probe = await api.request('/v3/jobs')
      assert.equal(v3Probe.status, 401)

      // Even with an auth-shaped header, unmounted /v3 falls through to notFound
      // after auth fails closed — confirm path is not a V3 success surface.
      const notFound = await api.request('/v3/jobs', {
        headers: { Authorization: 'Bearer not-a-session' }
      })
      assert.ok(
        notFound.status === 401 || notFound.status === 404,
        `expected 401/404 for unmounted /v3, got ${notFound.status}`
      )
    })
  })

  it('createApiRoutes still skips /v3 when test override is cutover_blocked', async () => {
    await withCompositionContext({ generation: 'copied' }, async (ctx) => {
      setCutoverMarkerForTests('cutover_blocked')
      const api = createApiRoutes(ctx)
      assert.equal(
        routePathsInclude(api, '/v3'),
        false,
        'production createApiRoutes must not mount /v3 even under test authoritative override'
      )
      assert.equal(routePathsInclude(api, '/core'), true)
    })
  })
})
