/**
 * Cursor ACP config helpers live on the Cursor driver turn-plan module.
 * This file remains only as a thin path for legacy diagnose imports of resolveCursorAgentBin.
 */
import { resolveProviderExecutable } from '../../providers/executable'
import { processHostEnvironmentSource } from '../../host-environment'

export {
  appendCursorApiEndpointArgs,
  resolveCursorApiEndpoint
} from '../../providers/cursor/turn-plan'

/** Resolve the Cursor agent executable from ProviderInstallation (no BIN env). */
export function resolveCursorAgentBin(
  env:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = processHostEnvironmentSource.snapshot()
): string {
  const resolved = resolveProviderExecutable('cursorcli', { env })
  if (resolved) return resolved.executable
  return 'agent'
}
