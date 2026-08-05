import type { ProviderSettings } from '../../spec/settings'
import { DelegatingProviderDriver, type ProviderStreamFactory } from '../delegating-driver'
import { CODEX_DESCRIPTOR } from './descriptor'
import { runCodexAuthPreflight } from './preflight'
import { prepareCodexRuntimeProfile } from '../../provider-auth/bridge'
import { resolveCodexInstallDirs } from '../../provider-auth/paths'

export {
  buildCodexTurnPlan,
  resolveCodexMcpToolNamesForTurn,
  resolveCodexOuterSandbox,
  resolveCodexPathOverride,
  type CodexSandboxMode,
  type CodexThreadOptions,
  type CodexTurnPlan
} from './turn-plan'

/** Default stream factory: delegates to the package-owned Codex SDK streamer. */
export function createCodexStreamFactory(): ProviderStreamFactory {
  return async function* (input, options) {
    const { streamCodexTurn } = await import('../../streamers/codex-sdk')
    yield* streamCodexTurn(input, options)
  }
}

/**
 * Codex production driver. Auth preflight, turn planning, and SDK streaming live in this package.
 */
export class CodexDriver extends DelegatingProviderDriver {
  constructor(
    settings: ProviderSettings,
    streamFactory: ProviderStreamFactory = createCodexStreamFactory()
  ) {
    super(CODEX_DESCRIPTOR, settings, streamFactory, {
      prepareRuntimeProfile: prepareCodexRuntimeProfile,
      preflight: (context) => runCodexAuthPreflight(context.runtimeProfile, context.installation),
      installDirs: () => resolveCodexInstallDirs()
    })
  }
}
