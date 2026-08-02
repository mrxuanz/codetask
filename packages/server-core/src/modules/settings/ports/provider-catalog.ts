import type { SettingsProviderCode } from '@codetask/contracts'

export type ProviderCatalogEntry = {
  code: SettingsProviderCode
  label: string
  available: boolean
}

export interface ProviderCatalogPort {
  listProviders(): Promise<ProviderCatalogEntry[]>
}
