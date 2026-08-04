import type { ProviderSettings } from '../../spec/settings'
import { DelegatingProviderDriver, type ProviderStreamFactory } from '../delegating-driver'
import { CLAUDE_DESCRIPTOR } from './descriptor'
import { runClaudeAuthPreflight } from './preflight'
import { prepareClaudeRuntimeProfile } from '@server/sandbox/provider-auth/bridge'
import { resolveClaudeInstallDirs } from '@server/sandbox/provider-auth/paths'

export {
  buildClaudeTurnOptions,
  resolveClaudePathOverride,
  resolveClaudeSettingSources,
  resolveClaudeSystemPrompt,
  type ClaudeSettingSource,
  type ClaudeSystemPrompt,
  type ClaudeTurnOptionsPlan
} from './turn-options'

/** Default stream factory: delegates to the package-owned Claude SDK streamer. */
export function createClaudeStreamFactory(): ProviderStreamFactory {
  return async function* (input, options) {
    const { streamClaudeTurn } = await import('../../streamers/claude-sdk')
    yield* streamClaudeTurn(input, options)
  }
}

/**
 * Claude production driver. Auth preflight, turn options, and SDK streaming live in this package.
 */
export class ClaudeDriver extends DelegatingProviderDriver {
  constructor(
    settings: ProviderSettings,
    streamFactory: ProviderStreamFactory = createClaudeStreamFactory()
  ) {
    super(CLAUDE_DESCRIPTOR, settings, streamFactory, {
      prepareRuntimeProfile: prepareClaudeRuntimeProfile,
      preflight: (context) => runClaudeAuthPreflight(context.runtimeProfile, context.installation),
      installDirs: () => resolveClaudeInstallDirs()
    })
  }
}
