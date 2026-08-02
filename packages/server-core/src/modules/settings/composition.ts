import type Database from 'better-sqlite3'
import { SettingsApplication } from './application/settings-application.ts'
import { createSettingsHttpRoutes, type SettingsHttpDeps } from './http/settings-routes.ts'
import { EncryptedSecretStore } from './infrastructure/encrypted-secret-store.ts'
import { SqliteSettingsRepository } from './infrastructure/sqlite-settings-repository.ts'
import type { SettingsEventsPort } from './ports/settings-events.ts'
import type { DefaultPromptBodies } from './domain/setting-namespace.ts'
import type { ProviderCatalogPort } from './ports/provider-catalog.ts'

export type SettingsModule = {
  app: SettingsApplication
  /** Routes relative to `/settings` mount point. */
  createRoutes: (http: Omit<SettingsHttpDeps, 'app'>) => ReturnType<typeof createSettingsHttpRoutes>
}

export type SettingsModuleDeps = {
  db: Database.Database
  masterKey?: string
  events: SettingsEventsPort
  clock?: () => number
  defaultPromptBodies?: DefaultPromptBodies
  providerCatalog?: ProviderCatalogPort
}

export function composeSettingsModule(deps: SettingsModuleDeps): SettingsModule {
  const repository = new SqliteSettingsRepository(deps.db)
  const secrets = new EncryptedSecretStore(deps.db, deps.masterKey)
  const app = new SettingsApplication({
    repository,
    secrets,
    events: deps.events,
    ...(deps.defaultPromptBodies ? { defaultPromptBodies: deps.defaultPromptBodies } : {}),
    ...(deps.providerCatalog ? { providerCatalog: deps.providerCatalog } : {}),
    ...(deps.clock ? { clock: deps.clock } : {})
  })

  return {
    app,
    createRoutes(http) {
      return createSettingsHttpRoutes({
        ...http,
        app
      })
    }
  }
}
