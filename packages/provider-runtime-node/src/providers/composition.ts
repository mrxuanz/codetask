import type { ProvidersConfig } from '../spec/settings'
import { DEFAULT_PROVIDERS_CONFIG } from '../spec/settings'
import { ClaudeDriver } from './claude/driver'
import { CodexDriver } from './codex/driver'
import { CursorDriver } from './cursor/driver'
import { OpenCodeDriver } from './opencode/driver'
import { ProviderRegistry } from './registry'

/** The only production Provider driver registration point. */
export function createProviderRegistry(
  settings: ProvidersConfig = DEFAULT_PROVIDERS_CONFIG
): ProviderRegistry {
  return new ProviderRegistry([
    new CodexDriver(settings.codex),
    new ClaudeDriver(settings.claude),
    new OpenCodeDriver(settings.opencode),
    new CursorDriver(settings.cursor)
  ])
}

export const DEFAULT_PROVIDER_REGISTRY = createProviderRegistry()
