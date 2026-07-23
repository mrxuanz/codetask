import { Hono } from 'hono'
import type { AppContext } from '../context'
import { requireUsername } from '../auth/session'
import { AppError } from '../error'
import { loadControlPlaneSettings, saveControlPlanePolicies } from '../settings/control-plane'
import {
  loadPromptSettingsPayload,
  savePromptSettings,
  type PromptSettings
} from '../settings/prompts'
import {
  loadUserMcpSettings,
  MCP_SETTINGS_CONSTRAINTS,
  redactUserMcpSettings,
  saveUserMcpSettings,
  type UserMcpSettings
} from '../settings/mcp'
import { ok } from '../response'
import { readStorageStats } from '../storage/stats'
import {
  confirmOldStorageDelete,
  getStorageMigration,
  startStorageMigration
} from '../storage/migration'
import { validateStorageTarget } from '../../main/storage-validation'
import { SettingsRevisionConflictError } from '../context/settings-store'
import { loadProviderSettings, saveProviderSettings } from '../settings/providers'

function unwrapSettings<T extends object>(body: T | { settings?: T }): T {
  if ('settings' in body && body.settings !== undefined) return body.settings
  return body as T
}

export function createSettingsRoutes(ctx: AppContext): Hono {
  const routes = new Hono()

  routes.get('/control-plane', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const payload = await loadControlPlaneSettings()
    return c.json(ok(payload))
  })

  routes.put('/control-plane', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{
      plannerCoreCode?: string
      sliceVerifierCoreCode?: string
      milestoneVerifierCoreCode?: string
    }>()
    try {
      const policies = await saveControlPlanePolicies({
        plannerCoreCode: body.plannerCoreCode?.trim() ?? '',
        sliceVerifierCoreCode: body.sliceVerifierCoreCode?.trim() ?? '',
        milestoneVerifierCoreCode: body.milestoneVerifierCoreCode?.trim() ?? ''
      })
      return c.json(ok({ policies }))
    } catch (error) {
      throw AppError.badRequest(
        error instanceof Error ? error.message : 'Failed to save Control Plane settings',
        'settings.control_plane.save_failed'
      )
    }
  })

  routes.get('/prompts', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    return c.json(ok(loadPromptSettingsPayload()))
  })

  routes.put('/prompts', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<PromptSettings | { settings?: PromptSettings }>()
    const settings = unwrapSettings(body)
    const saved = savePromptSettings(settings)
    return c.json(ok({ settings: saved }))
  })

  routes.get('/mcp', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    return c.json(
      ok({
        settings: redactUserMcpSettings(loadUserMcpSettings()),
        constraints: MCP_SETTINGS_CONSTRAINTS
      })
    )
  })

  routes.put('/mcp', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<UserMcpSettings | { settings?: UserMcpSettings }>()
    const settings = unwrapSettings(body)
    try {
      const saved = saveUserMcpSettings(settings)
      return c.json(ok({ settings: redactUserMcpSettings(saved) }))
    } catch (error) {
      throw AppError.badRequest(
        error instanceof Error ? error.message : 'Failed to save MCP settings',
        'settings.mcp.save_failed'
      )
    }
  })

  routes.get('/providers', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    return c.json(ok(loadProviderSettings()))
  })

  routes.put('/providers', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const rawBody = await c.req.json<unknown>()
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw AppError.badRequest(
        'Provider settings payload must be an object',
        'settings.providers.invalid_payload'
      )
    }
    const body = rawBody as Record<string, unknown>
    for (const key of Object.keys(body)) {
      if (key !== 'providers' && key !== 'expectedRevision') {
        throw AppError.badRequest(
          `Provider settings field ${key} is not supported`,
          'settings.providers.invalid_payload'
        )
      }
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'providers')) {
      throw AppError.badRequest('providers is required', 'settings.providers.invalid_payload')
    }
    if (
      body.expectedRevision !== undefined &&
      (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    ) {
      throw AppError.badRequest(
        'expectedRevision must be a non-negative integer',
        'settings.providers.invalid_revision'
      )
    }
    try {
      return c.json(
        ok(saveProviderSettings(body.providers, body.expectedRevision as number | undefined))
      )
    } catch (error) {
      if (error instanceof SettingsRevisionConflictError) {
        throw AppError.conflict('Provider settings were updated by another request', {
          expectedRevision: error.expectedRevision,
          currentRevision: error.actualRevision
        })
      }
      throw AppError.badRequest(
        error instanceof Error ? error.message : 'Failed to save Provider settings',
        'settings.providers.save_failed'
      )
    }
  })

  routes.get('/storage', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    return c.json(ok(await readStorageStats(ctx)))
  })

  routes.post('/storage/validate-target', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    if (!ctx.storage?.bootstrapRoot || ctx.storage.managed) {
      throw AppError.conflict('Storage location is managed by CLI or environment')
    }
    const body = await c.req.json<{ path?: string }>()
    const result = validateStorageTarget({
      path: body.path ?? '',
      forbiddenRoots: [ctx.storage.bootstrapRoot, ctx.dataDir]
    })
    if (!result.ok) throw AppError.badRequest(result.issue ?? 'Storage target is invalid')
    return c.json(ok(result))
  })

  routes.post('/storage/migrations', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ targetPath?: string }>()
    try {
      return c.json(ok(startStorageMigration(ctx, body.targetPath ?? '')))
    } catch (error) {
      throw AppError.conflict(
        error instanceof Error ? error.message : 'Storage migration could not start'
      )
    }
  })

  routes.get('/storage/migrations/:id', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const migration = getStorageMigration(ctx, c.req.param('id'))
    if (!migration) throw AppError.notFound('Storage migration not found')
    return c.json(ok(migration))
  })

  routes.post('/storage/migrations/:id/confirm-old-delete', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const deleted = await confirmOldStorageDelete(ctx, c.req.param('id'))
    if (!deleted) throw AppError.conflict('Old storage cannot be deleted yet')
    return c.json(ok({ deleted: true }))
  })

  return routes
}
