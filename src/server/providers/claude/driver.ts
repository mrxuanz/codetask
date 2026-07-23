import type { ProviderSettings } from '../../../shared/providers/settings'
import { DelegatingProviderDriver, type ProviderStreamFactory } from '../delegating-driver'
import { CLAUDE_DESCRIPTOR } from './descriptor'
import { runClaudeAuthPreflight } from './preflight'
import { prepareClaudeAuth } from '../../sandbox/provider-auth/bridge'
import { resolveClaudeInstallDirs } from '../../sandbox/provider-auth/paths'

export {
  buildClaudeTurnOptions,
  resolveClaudePathOverride,
  resolveClaudeSettingSources,
  resolveClaudeSystemPrompt,
  type ClaudeSettingSource,
  type ClaudeSystemPrompt,
  type ClaudeTurnOptionsPlan
} from './turn-options'

/** Default stream factory: delegates to the existing Claude SDK turn implementation. */
export function createClaudeStreamFactory(): ProviderStreamFactory {
  return async function* (input, options) {
    const { streamClaudeTurn } = await import('../../agent-runtime/providers/claude-sdk')
    yield* streamClaudeTurn(input, options)
  }
}

/**
 * Claude production driver. Auth preflight and turn-options ownership live here;
 * turn streaming still delegates to the legacy SDK path until later wiring settles.
 */
export class ClaudeDriver extends DelegatingProviderDriver {
  constructor(
    settings: ProviderSettings,
    streamFactory: ProviderStreamFactory = createClaudeStreamFactory()
  ) {
    super(CLAUDE_DESCRIPTOR, settings, streamFactory, {
      prepareAuth: prepareClaudeAuth,
      preflight: (context) => runClaudeAuthPreflight(context.preparedAuth, context.installation),
      installDirs: () => resolveClaudeInstallDirs()
    })
  }
}
