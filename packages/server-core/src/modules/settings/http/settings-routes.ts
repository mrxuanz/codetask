import { Hono, type Context } from 'hono'
import type { ProviderRuntimeSettings } from '@codetask/contracts'
import type { SettingsApplication } from '../application/settings-application.ts'
import { SettingsError } from '../domain/settings-errors.ts'

export type SettingsHttpDeps = {
  app: SettingsApplication
  requireAuth: () => void
  ok: <T>(data: T, requestId: string) => unknown
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

function onSettingsError(error: unknown, _deps: SettingsHttpDeps, c: Context): Response {
  if (error instanceof SettingsError) {
    const requestId = (c.get('requestId' as never) as string | undefined) ?? 'local'
    const body = {
      success: false,
      error: {
        code: String(error.code),
        message: error.message,
        ...(error.details ? { details: error.details } : {})
      },
      requestId
    } as const
    return c.json(body, error.httpStatus as 400 | 409)
  }
  throw error
}

function requestId(c: Context): string {
  return (c.get('requestId' as never) as string | undefined) ?? 'unknown'
}

async function parseSettingsBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw SettingsError.badRequest('settings.invalid_payload', 'Request body must be valid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw SettingsError.badRequest('settings.invalid_payload', 'Invalid settings request body')
  }
  return body as Record<string, unknown>
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
    return c.json(deps.ok(app.getAgentDefaults(), requestId(c)))
  })

  routes.put('/agent-defaults', async (c) => {
    deps.requireAuth()
    const body = await parseSettingsBody(c)
    const expectedRevision = requireExpectedRevision(body.expectedRevision)
    const { expectedRevision: _ignored, ...value } = body
    try {
      const result = await app.updateAgentDefaults(expectedRevision, value)
      return c.json(deps.ok(result, requestId(c)))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/prompts', (c) => {
    deps.requireAuth()
    return c.json(deps.ok(app.getPrompts(), requestId(c)))
  })

  routes.put('/prompts', async (c) => {
    deps.requireAuth()
    const body = await parseSettingsBody(c)
    const expectedRevision = requireExpectedRevision(body.expectedRevision)
    const { settings } = unwrapSettings(body)
    try {
      const result = await app.updatePrompts(expectedRevision, settings)
      return c.json(deps.ok(result, requestId(c)))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/mcp', (c) => {
    deps.requireAuth()
    return c.json(deps.ok(app.getMcp(), requestId(c)))
  })

  routes.put('/mcp', async (c) => {
    deps.requireAuth()
    const body = await parseSettingsBody(c)
    const expectedRevision = requireExpectedRevision(body.expectedRevision)
    const { settings } = unwrapSettings(body)
    try {
      const result = await app.updateMcp(expectedRevision, settings)
      return c.json(deps.ok(result, requestId(c)))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/providers', (c) => {
    deps.requireAuth()
    return c.json(deps.ok(app.getProviders(deps.getEffectiveProviders()), requestId(c)))
  })

  routes.put('/providers', async (c) => {
    deps.requireAuth()
    const body = await parseSettingsBody(c)
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
      return c.json(deps.ok(result, requestId(c)))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  routes.get('/secrets', (c) => {
    deps.requireAuth()
    return c.json(deps.ok({ secrets: app.listSecrets() }, requestId(c)))
  })

  routes.put('/secrets/:name', async (c) => {
    deps.requireAuth()
    const name = c.req.param('name')
    const body = await parseSettingsBody(c)
    if (typeof body.value !== 'string') {
      deps.badRequest('value is required', 'settings.invalid_payload')
    }
    try {
      const secret = app.putSecret(name, body.value)
      return c.json(deps.ok({ secret }, requestId(c)))
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
      return c.json(deps.ok({ deleted: true, name }, requestId(c)))
    } catch (error) {
      if (error instanceof SettingsError) mapSettingsError(error, deps)
      throw error
    }
  })

  if (deps.listProviderCores) {
    routes.get('/provider-catalog', async (c) => {
      deps.requireAuth()
      const providers = await deps.listProviderCores!()
      return c.json(deps.ok({ providers }, requestId(c)))
    })
  }

  return routes
}
