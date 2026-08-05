import type { ProviderSettings } from '../../spec/settings'
import { DelegatingProviderDriver, type ProviderStreamFactory } from '../delegating-driver'
import { OPENCODE_DESCRIPTOR } from './descriptor'
import { runOpenCodeAuthPreflight } from './preflight'
import { prepareOpenCodeRuntimeProfile } from '../../provider-auth/bridge'
import { resolveOpencodeInstallDirs } from '../../provider-auth/paths'

export {
  buildOpenCodeConfig,
  buildOpenCodeServerPlan,
  resolveOpenCodePathOverride,
  type OpenCodeServerPlan
} from './server-plan'

/** Default stream factory: delegates to the package-owned OpenCode SDK streamer. */
export function createOpenCodeStreamFactory(): ProviderStreamFactory {
  return async function* (input, options) {
    const { streamOpencodeTurn } = await import('../../streamers/opencode-sdk')
    yield* streamOpencodeTurn(input, options)
  }
}

/**
 * OpenCode production driver. Auth preflight, server planning, and SDK streaming live here.
 */
export class OpenCodeDriver extends DelegatingProviderDriver {
  constructor(
    settings: ProviderSettings,
    streamFactory: ProviderStreamFactory = createOpenCodeStreamFactory()
  ) {
    super(OPENCODE_DESCRIPTOR, settings, streamFactory, {
      prepareRuntimeProfile: prepareOpenCodeRuntimeProfile,
      preflight: (context) =>
        runOpenCodeAuthPreflight(context.runtimeProfile, context.installation),
      installDirs: () => resolveOpencodeInstallDirs()
    })
  }
}
