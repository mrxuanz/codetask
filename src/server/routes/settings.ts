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
  saveUserMcpSettings,
  type UserMcpSettings
} from '../settings/mcp'
import { ok } from '../response'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createSettingsRoutes(_ctx: AppContext): Hono {
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
    const body = await c.req.json<{ settings?: PromptSettings }>()
    const settings = body.settings ?? (body as unknown as PromptSettings)
    const saved = savePromptSettings(settings)
    return c.json(ok({ settings: saved }))
  })

  routes.get('/mcp', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    return c.json(ok({ settings: loadUserMcpSettings(), constraints: MCP_SETTINGS_CONSTRAINTS }))
  })

  routes.put('/mcp', async (c) => {
    await requireUsername(c.req.header('Authorization'))
    const body = await c.req.json<{ settings?: UserMcpSettings }>()
    const settings = body.settings ?? (body as unknown as UserMcpSettings)
    try {
      const saved = saveUserMcpSettings(settings)
      return c.json(ok({ settings: saved }))
    } catch (error) {
      throw AppError.badRequest(
        error instanceof Error ? error.message : 'Failed to save MCP settings',
        'settings.mcp.save_failed'
      )
    }
  })

  return routes
}
