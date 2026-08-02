/**
 * Host-facing re-export: ProviderRuntimeManager remains implemented under
 * `src/server/providers` (SDK/ACP adapters). Business modules must use
 * `createAgentRuntime` from this package — never import Manager directly.
 */
export { resolveReusePolicy as resolveProviderReusePolicy } from './index.ts'
