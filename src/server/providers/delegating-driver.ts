import { dirname } from 'node:path'
import type { ProviderDescriptor } from '../../shared/providers/descriptor'
import type { ProviderInstallation } from '../../shared/providers/installation'
import type { ProviderCapabilityProfile } from '../../shared/providers/capabilities'
import type { ProviderSettings } from '../../shared/providers/settings'
import type {
  AgentTurnChunk,
  AgentTurnInput,
  AgentTurnOptions,
  AgentTurnProvider
} from '../agent-runtime/types'
import type {
  PreparedProviderTurn,
  ProviderAuthPreparationContext,
  ProviderDiscoveryContext,
  ProviderDriver,
  ProviderPreflightContext,
  ProviderSandboxContribution,
  ProviderTurnContext,
  SandboxPolicyContext
} from './driver'
import { providerInstallationResolver, type ProviderInstallationResolver } from './installation'
import { processHostEnvironmentSource, type HostEnvironmentSource } from '../host-environment'
import { resolveProviderReusePolicy } from './lifecycle'
import type { HostEnvironmentSnapshot } from '../host-environment'
import type { ProviderAuthPrepared } from '../sandbox/provider-auth/types'

export type ProviderStreamFactory = (
  input: AgentTurnInput,
  options?: AgentTurnOptions
) => AsyncGenerator<AgentTurnChunk>

export interface ProviderDriverHooks {
  readonly prepareAuth: (context: ProviderAuthPreparationContext) => ProviderAuthPrepared
  readonly preflight: (context: ProviderPreflightContext) => void
  readonly installDirs: (hostEnvironment: HostEnvironmentSnapshot) => readonly string[]
}

function forwardSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined
  const abort = (): void => {
    if (!target.signal.aborted) target.abort(source.reason)
  }
  source.addEventListener('abort', abort, { once: true })
  if (source.aborted) abort()
  return () => source.removeEventListener('abort', abort)
}

export function createPreparedProviderTurn(input: {
  installation: ProviderInstallation
  turn: ProviderTurnContext
  streamFactory: ProviderStreamFactory
}): PreparedProviderTurn {
  const controller = new AbortController()
  let started = false
  let closed = false
  let activeIterator: AsyncGenerator<AgentTurnChunk> | null = null

  return {
    installation: input.installation,
    reusePolicy:
      input.turn.runtimeScope?.reusePolicy ??
      resolveProviderReusePolicy(input.turn.input.role, input.turn.input.capabilityProfile),
    async *stream(signal?: AbortSignal): AsyncGenerator<AgentTurnChunk> {
      if (started) throw new Error('PreparedProviderTurn.stream may only be consumed once')
      if (closed) throw new Error('PreparedProviderTurn is closed')
      started = true
      const detachExternal = forwardSignal(signal, controller)
      const detachOption = forwardSignal(input.turn.options?.signal, controller)
      const turnInput: AgentTurnInput = {
        ...input.turn.input,
        runtimeRoot: input.turn.controls.runtimeRoot,
        installation: input.installation,
        providerSettings: input.turn.input.providerSettings,
        providerRuntimeScope: input.turn.runtimeScope
      }
      activeIterator = input.streamFactory(turnInput, {
        ...input.turn.options,
        outerSandbox: input.turn.controls.outerSandbox,
        signal: controller.signal
      })
      try {
        yield* activeIterator
      } finally {
        detachExternal()
        detachOption()
        await activeIterator.return?.(undefined).catch(() => undefined)
        activeIterator = null
      }
    },
    async cancel(reason: Error): Promise<void> {
      if (!controller.signal.aborted) controller.abort(reason)
      await activeIterator?.return?.(undefined).catch(() => undefined)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      if (activeIterator) {
        if (!controller.signal.aborted) {
          controller.abort(new Error('Provider turn closed'))
        }
        await activeIterator.return?.(undefined).catch(() => undefined)
      }
    }
  }
}

export class DelegatingProviderDriver implements ProviderDriver {
  readonly kind = 'production' as const

  constructor(
    readonly descriptor: ProviderDescriptor,
    readonly settings: ProviderSettings,
    private readonly streamFactory: ProviderStreamFactory,
    private readonly hooks: ProviderDriverHooks,
    private readonly installationResolver: ProviderInstallationResolver = providerInstallationResolver,
    private readonly hostEnvironmentSource: HostEnvironmentSource = processHostEnvironmentSource
  ) {}

  async discover(context: ProviderDiscoveryContext = {}): Promise<ProviderInstallation | null> {
    const hostEnvironment = context.hostEnvironment ?? this.hostEnvironmentSource.snapshot()
    return this.installationResolver.resolve(this.descriptor.code, {
      settings: context.settings ?? this.settings,
      hostEnv: hostEnvironment,
      platform: context.platform,
      installDirs: context.installDirs ?? this.installDirs(hostEnvironment)
    })
  }

  installDirs(
    hostEnvironment: HostEnvironmentSnapshot = this.hostEnvironmentSource.snapshot()
  ): readonly string[] {
    return this.hooks.installDirs(hostEnvironment)
  }

  prepareAuth(context: ProviderAuthPreparationContext): ProviderAuthPrepared {
    return this.hooks.prepareAuth(context)
  }

  preflight(context: ProviderPreflightContext): void {
    if (context.skipAuthProbe) return
    this.hooks.preflight(context)
  }

  supports(profile: ProviderCapabilityProfile): boolean {
    return this.descriptor.capabilities.supportedProfiles.includes(profile)
  }

  async prepareTurn(context: ProviderTurnContext): Promise<PreparedProviderTurn> {
    const installation = context.installation ?? (await this.discover())
    if (!installation) {
      throw new Error(`${this.descriptor.label} is not installed or is disabled`)
    }
    return createPreparedProviderTurn({
      installation,
      turn: context,
      streamFactory: this.streamFactory
    })
  }

  contributeSandboxPolicy(context: SandboxPolicyContext): ProviderSandboxContribution {
    return {
      readRoots: [
        dirname(context.installation.resolvedPath),
        dirname(context.installation.canonicalPath),
        ...this.installDirs(context.hostEnvironment),
        ...context.preparedAuth.readRoots
      ],
      writeRoots: context.preparedAuth.writeRoots ?? [],
      environment: context.preparedAuth.envPatch,
      credentialSnapshots: context.preparedAuth.filesystemProfile.credentialSnapshots
    }
  }

  async shutdown(): Promise<void> {
    // Most SDK/CLI providers own no shared transport outside a prepared turn.
  }
}

export function createTestOverrideDriver(
  base: ProviderDriver,
  provider: AgentTurnProvider
): ProviderDriver {
  return {
    kind: 'test-fake',
    descriptor: base.descriptor,
    settings: base.settings,
    discover: (context) => base.discover(context),
    preflight: (context) => base.preflight(context),
    installDirs: (hostEnvironment) => base.installDirs(hostEnvironment),
    prepareAuth: (context) => base.prepareAuth(context),
    supports: (profile) => base.supports(profile),
    contributeSandboxPolicy: (context) => base.contributeSandboxPolicy(context),
    shutdown: () => base.shutdown?.() ?? Promise.resolve(),
    async prepareTurn(context): Promise<PreparedProviderTurn> {
      const installation = context.installation ??
        (await base.discover({
          installDirs: []
        })) ?? {
          id: `${base.descriptor.code}:test-fake`,
          provider: base.descriptor.code,
          command: 'test-fake',
          source: 'path',
          invocation: { executable: 'test-fake', prefixArgs: [] },
          resolvedPath: 'test-fake',
          canonicalPath: 'test-fake'
        }
      return createPreparedProviderTurn({
        installation,
        turn: context,
        streamFactory: (input, options) => provider.streamTurn(input, options)
      })
    }
  }
}
