import {
  createClaudeProviderAdapter,
  createCodexProviderAdapter,
  createCursorProviderAdapter,
  createFakeProviderAdapter,
  createOpenCodeProviderAdapter,
  PROVIDER_ADAPTER_CODES,
  type ProviderAdapter,
  type ProviderAdapterCode,
  type ProviderRegistry
} from '../adapters/providers/index'

/**
 * Composition-root registration for all Provider adapters (Fake + four production).
 * Domain/application must obtain adapters only through this registry.
 */
export function createProviderRegistry(
  overrides: Partial<Record<ProviderAdapterCode, ProviderAdapter>> = {}
): ProviderRegistry {
  const adapters: ProviderAdapter[] = [
    overrides.fake ?? createFakeProviderAdapter(),
    overrides.opencode ?? createOpenCodeProviderAdapter({ stubMode: true }),
    overrides.codex ?? createCodexProviderAdapter({ stubMode: true }),
    overrides.claude ?? createClaudeProviderAdapter({ stubMode: true }),
    overrides.cursor ?? createCursorProviderAdapter({ stubMode: true })
  ]

  const byCode = new Map<string, ProviderAdapter>()
  for (const adapter of adapters) {
    if (byCode.has(adapter.code)) {
      throw new Error(`Duplicate ProviderAdapter registration: ${adapter.code}`)
    }
    byCode.set(adapter.code, adapter)
  }

  const missing = PROVIDER_ADAPTER_CODES.filter((code) => !byCode.has(code))
  if (missing.length > 0) {
    throw new Error(`Missing ProviderAdapter registrations: ${missing.join(', ')}`)
  }

  return {
    get(code: string): ProviderAdapter | undefined {
      return byCode.get(code)
    },
    list(): readonly ProviderAdapter[] {
      return PROVIDER_ADAPTER_CODES.map((code) => byCode.get(code)!)
    },
    codes(): readonly ProviderAdapterCode[] {
      return PROVIDER_ADAPTER_CODES
    },
    has(code: string): boolean {
      return byCode.has(code)
    }
  }
}
