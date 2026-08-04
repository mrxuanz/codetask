import type { ProviderCapabilities } from './capabilities'
import type { SupportedCoreCode } from './codes'

/** Serializable Provider metadata safe to cross server/renderer boundaries. */
export interface ProviderDescriptor {
  readonly code: SupportedCoreCode
  readonly aliases: readonly string[]
  readonly label: string
  readonly description: string
  readonly defaultCommands: readonly string[]
  readonly authEnvironmentKeys: readonly string[]
  readonly childEnvironmentKeys: readonly string[]
  readonly mcpRootKey: 'mcp_servers' | 'mcpServers' | 'mcp'
  readonly capabilities: ProviderCapabilities
}
