import { Hono, type Context } from 'hono'
import type { ProviderRuntimeSettings } from '@codetask/contracts'
import type { SettingsApplication } from '../application/settings-application.ts'
import { SettingsError } from '../domain/settings-errors.ts'

export type SettingsHttpDeps = {
  app: SettingsApplication
  requireAuth: () => void
  ok: <T>(data: T) => unknown
  badRequest: (message: string, code?: string, details?: Record<string, unknown>) => never
  conflict: (message: string, code?: string, details?: Record<string, unknown>) => never
  getEffectiveProviders: () => ProviderRuntimeSettings
  listProviderCores?: () => Promise<
    Array<{
      code: string
      label: string
      available: boolean
      description?: string
      readOnlyCapable?: boolean
      reason?: string | null
    }>
  >
}

function unwrapSettings<T extends object>(
  body: T | { settings?: T; expectedRevision?: number }
): {
  settings: T
  expectedRevision?: number
} {
  if ('settings' in body && body.settings !== undefined) {
    return {
      settings: body.settings,
      expectedRevision: body.expectedRevision
    }
  }
  const { expectedRevision, ...rest } = body as T & { expectedRevision?: number }
  return { settings: rest as T, expectedRevision }
}

function requireExpectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw SettingsError.badRequest(
      'settings.invalid_payload',
      'expectedRevision must be a non-negative integer'
    )
  }
  return Number(value)
}

function mapSettingsError(
  error: SettingsError,
  deps: Pick<SettingsHttpDeps, 'badRequest' | 'conflict'>
): never {
  if (error.httpStatus === 409) {
    deps.conflict(error.message, String(error.code), error.details)
  }
  deps.badRequest(error.message, String(error.code), error.details)
}

function onSettingsError(error: unknown, deps: SettingsHttpDeps, c: Context): Response {
  if (error instanceof SettingsError) {
    const status = error.httpStatus
    const body = deps.ok({
      success: false,
      error: { code: error.code, message: error.message, details: error.details }
    })
    return c.json(body, status as 400)
  }
  throw error
}

/**
 * Settings HTTP routes mounted at `/settings` (full paths `/api/settings/*`).
 */
export function createSettingsHttpRoutes(deps: SettingsHttpDeps): Hono {
  const routes = new Hono()
  const app = deps.app

  routes.onError((error, c) => onSettingsError(error, deps, c))

  routes.get('/agent-defaults', (c) => {
    deps.requireAuth()
    return c.json(deps.ok(app.getAgentDefaults()))
  })

  routes.put('/agent-defaults', async (c) => {
    deps.requireAuth()
    const body = await c.req.json<{ expectedRevision?: number } & Record<string, unknown>>()
    const expectedRevision = requireExpectedRevision(body.expectedRevision)
    const { expectedRevision: _ignored, ...value } = body
    try {
      const result = await app.updateAgentDefaults(expectedRevision, value)
      return c.json(deps.ok(result))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/prompts', (c) => {
    deps.requireAuth()
    return c.json(deps.ok(app.getPrompts()))
  })

  routes.put('/prompts', async (c) => {
    deps.requireAuth()
    const body = await c.req.json<
      { expectedRevision?: number; settings?: unknown } & Record<string, unknown>
    >()
    const expectedRevision = requireExpectedRevision(body.expectedRevision)
    const { settings } = unwrapSettings(body)
    try {
      const result = await app.updatePrompts(expectedRevision, settings)
      return c.json(deps.ok(result))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/mcp', (c) => {
    deps.requireAuth()
    return c.json(deps.ok(app.getMcp()))
  })

  routes.put('/mcp', async (c) => {
    deps.requireAuth()
    const body = await c.req.json<
      { expectedRevision?: number; settings?: unknown } & Record<string, unknown>
    >()
    const expectedRevision = requireExpectedRevision(body.expectedRevision)
    const { settings } = unwrapSettings(body)
    try {
      const result = await app.updateMcp(expectedRevision, settings)
      return c.json(deps.ok(result))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/providers', (c) => {
    deps.requireAuth()
    return c.json(deps.ok(app.getProviders(deps.getEffectiveProviders())))
  })

  routes.put('/providers', async (c) => {
    deps.requireAuth()
    const body = await c.req.json<{ expectedRevision?: number; providers?: unknown }>()
    const expectedRevision = requireExpectedRevision(body.expectedRevision)
    if (body.providers === undefined) {
      deps.badRequest('providers is required', 'settings.invalid_payload')
    }
    try {
      const result = await app.updateProviders(
        expectedRevision,
        { providers: body.providers },
        deps.getEffectiveProviders()
      )
      return c.json(deps.ok(result))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/secrets', (c) => {
    deps.requireAuth()
    return c.json(deps.ok({ secrets: app.listSecrets() }))
  })

  routes.put('/secrets/:name', async (c) => {
    deps.requireAuth()
    const name = c.req.param('name')
    const body = await c.req.json<{ value?: string }>()
    if (typeof body.value !== 'string') {
      deps.badRequest('value is required', 'settings.invalid_payload')
    }
    try {
      const secret = app.putSecret(name, body.value)
      return c.json(deps.ok({ secret }))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.delete('/secrets/:name', (c) => {
    deps.requireAuth()
    const name = c.req.param('name')
    try {
      app.deleteSecret(name)
      return c.json(deps.ok({ deleted: true, name }))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  if (deps.listProviderCores) {
    routes.get('/provider-catalog', async (c) => {
      deps.requireAuth()
      const providers = await deps.listProviderCores!()
      return c.json(deps.ok({ providers }))
    })
  }

  return routes
}
