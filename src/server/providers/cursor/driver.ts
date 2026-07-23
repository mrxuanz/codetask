import type { ProviderSettings } from '../../../shared/providers/settings'
import { DelegatingProviderDriver, type ProviderStreamFactory } from '../delegating-driver'
import { CURSOR_DESCRIPTOR } from './descriptor'
import { runCursorAuthPreflight } from './preflight'
import { prepareCursorAuth } from '../../sandbox/provider-auth/bridge'
import {
  resolveCursorAgentInstallDirs,
  resolveHostProfilePaths
} from '../../sandbox/provider-auth/paths'

export {
  appendCursorApiEndpointArgs,
  buildCursorAcpCliArgs,
  buildCursorTurnPlan,
  resolveCursorApiEndpoint,
  resolveCursorPathOverride,
  type CursorTurnPlan
} from './turn-plan'

/** Default stream factory: delegates to the existing Cursor ACP turn implementation. */
export function createCursorStreamFactory(
  settings: Pick<ProviderSettings, 'endpoint' | 'approveMcps'> = {
    endpoint: undefined,
    approveMcps: true
  }
): ProviderStreamFactory {
  return async function* (input, options) {
    const { streamCursorAcpTurn } = await import('../../agent-runtime/providers/cursor-acp')
    const turnSettings = input.providerSettings ?? settings
    yield* streamCursorAcpTurn(input, {
      ...options,
      endpoint: turnSettings.endpoint,
      approveMcps: turnSettings.approveMcps
    })
  }
}

/**
 * Cursor production driver. Auth preflight and ACP turn-plan ownership live here;
 * ProviderRuntimeManager selects one-shot vs conversation reuse. The ACP registry
 * is only the protocol-specific transport pool for manager-selected conversation scopes.
 */
export class CursorDriver extends DelegatingProviderDriver {
  constructor(
    settings: ProviderSettings,
    streamFactory: ProviderStreamFactory = createCursorStreamFactory(settings)
  ) {
    super(CURSOR_DESCRIPTOR, settings, streamFactory, {
      prepareAuth: prepareCursorAuth,
      preflight: (context) => runCursorAuthPreflight(context.preparedAuth, context.installation),
      installDirs: (hostEnvironment) =>
        resolveCursorAgentInstallDirs(resolveHostProfilePaths(hostEnvironment))
    })
  }

  override async shutdown(): Promise<void> {
    const { getCursorProviderRuntimeRegistry } =
      await import('../../agent-runtime/cursor-acp/runtime-registry')
    await getCursorProviderRuntimeRegistry().closeAll()
  }
}
