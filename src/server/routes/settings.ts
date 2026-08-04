import { Hono } from 'hono'
import type { ProviderRuntimeSettings } from '@codetask/contracts'
import type { AppContext } from '../context'
import { requireAuthPrincipal } from '../auth/session'
import { AppError } from '../error'
import { ok } from '../response'
import { getOrComposeSettings } from '../settings/service'
import { listChatCores } from '../conversation/cores'

function getEffectiveProviders(ctx: AppContext): ProviderRuntimeSettings {
  return {
    providers: structuredClone(ctx.config.providers) as ProviderRuntimeSettings['providers']
  }
}

export function createSettingsRoutes(ctx: AppContext): Hono {
  const settings = getOrComposeSettings(ctx)
  return settings.createRoutes({
    requireAuth: () => {
      requireAuthPrincipal()
    },
    ok,
    badRequest: (message, code, details) => {
      throw AppError.badRequest(message, code, details)
    },
    conflict: (message, code, details) => {
      throw AppError.conflict(message, details, code)
    },
    getEffectiveProviders: () => getEffectiveProviders(ctx),
    listProviderCores: async () => {
      const cores = await listChatCores()
      return cores.map((core) => ({
        code: core.code,
        label: core.label,
        description: core.description,
        available: core.available,
        ...(core.readOnlyCapable !== undefined ? { readOnlyCapable: core.readOnlyCapable } : {}),
        ...(core.reason ? { reason: core.reason } : {})
      }))
    }
  })
}
