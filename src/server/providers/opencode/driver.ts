import type { ProviderSettings } from '../../../shared/providers/settings'
import { DelegatingProviderDriver, type ProviderStreamFactory } from '../delegating-driver'
import { OPENCODE_DESCRIPTOR } from './descriptor'
import { runOpenCodeAuthPreflight } from './preflight'
import { prepareOpenCodeAuth } from '../../sandbox/provider-auth/bridge'
import { resolveOpencodeInstallDirs } from '../../sandbox/provider-auth/paths'

export {
  buildOpenCodeConfig,
  buildOpenCodeServerPlan,
  resolveOpenCodePathOverride,
  type OpenCodeServerPlan
} from './server-plan'

/** Default stream factory: delegates to the existing OpenCode SDK turn implementation. */
export function createOpenCodeStreamFactory(): ProviderStreamFactory {
  return async function* (input, options) {
    const { streamOpencodeTurn } = await import('../../agent-runtime/providers/opencode-sdk')
    yield* streamOpencodeTurn(input, options)
  }
}

/**
 * OpenCode production driver. Auth preflight and server-plan ownership live here;
 * turn streaming still delegates to the legacy SDK path until later wiring settles.
 */
export class OpenCodeDriver extends DelegatingProviderDriver {
  constructor(
    settings: ProviderSettings,
    streamFactory: ProviderStreamFactory = createOpenCodeStreamFactory()
  ) {
    super(OPENCODE_DESCRIPTOR, settings, streamFactory, {
      prepareAuth: prepareOpenCodeAuth,
      preflight: (context) => runOpenCodeAuthPreflight(context.preparedAuth, context.installation),
      installDirs: () => resolveOpencodeInstallDirs()
    })
  }
}
