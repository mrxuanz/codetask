import type { ProviderSettings } from '../../../shared/providers/settings'
import { DelegatingProviderDriver, type ProviderStreamFactory } from '../delegating-driver'
import { CODEX_DESCRIPTOR } from './descriptor'
import { runCodexAuthPreflight } from './preflight'
import { prepareCodexRuntimeProfile } from '../../sandbox/provider-auth/bridge'
import { resolveCodexInstallDirs } from '../../sandbox/provider-auth/paths'

export {
  buildCodexTurnPlan,
  resolveCodexMcpToolNamesForTurn,
  resolveCodexOuterSandbox,
  resolveCodexPathOverride,
  type CodexSandboxMode,
  type CodexThreadOptions,
  type CodexTurnPlan
} from './turn-plan'

/** Default stream factory: delegates to the existing Codex SDK turn implementation. */
export function createCodexStreamFactory(): ProviderStreamFactory {
  return async function* (input, options) {
    const { streamCodexTurn } = await import('../../agent-runtime/providers/codex-sdk')
    yield* streamCodexTurn(input, options)
  }
}

/**
 * Codex production driver. Auth preflight and turn-plan ownership live in this module;
 * turn streaming still delegates to the legacy SDK path until later PRU-07 steps.
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
