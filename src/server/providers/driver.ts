import type { ProviderDescriptor } from '../../shared/providers/descriptor'
import type { ProviderInstallation } from '../../shared/providers/installation'
import type {
  ProviderAuthMode,
  ProviderCapabilityProfile,
  ProviderReusePolicy,
  ProviderRuntimeScope
} from '../../shared/providers/capabilities'
import type { ProviderSettings } from '../../shared/providers/settings'
import type { AgentTurnChunk, AgentTurnInput, AgentTurnOptions } from '../agent-runtime/types'
import type { ProviderAuthPrepared } from '../sandbox/provider-auth/types'
import type { HostEnvironmentSnapshot } from '../host-environment'

export interface ProviderDiscoveryContext {
  readonly hostEnvironment?: HostEnvironmentSnapshot | undefined
  readonly settings?: ProviderSettings | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly installDirs?: readonly string[] | undefined
}

export interface ProviderPreflightContext {
  readonly installation: ProviderInstallation
  readonly preparedAuth: ProviderAuthPrepared
  readonly skipAuthProbe?: boolean | undefined
}

export interface ProviderAuthPreparationContext {
  readonly runtimeRoot: string
  readonly workspaceRoot?: string | undefined
  readonly hostEnvironment: HostEnvironmentSnapshot
}

/**
 * Explicit turn controls for CodeTask-internal decisions.
 * Never derive these from process.env between modules.
 */
export interface ProviderTurnControls {
  readonly runtimeRoot: string
  readonly outerSandbox: boolean
  readonly authMode: ProviderAuthMode
}

export interface ProviderTurnContext {
  readonly input: AgentTurnInput
  readonly options?: AgentTurnOptions | undefined
  readonly installation?: ProviderInstallation | undefined
  readonly runtimeScope?: ProviderRuntimeScope | undefined
  readonly controls: ProviderTurnControls
}

/** Build a turn context with explicit controls; never reads process.env. */
export function buildProviderTurnContext(input: {
  readonly input: AgentTurnInput
  readonly options?: AgentTurnOptions | undefined
  readonly installation?: ProviderInstallation | undefined
  readonly authMode: ProviderAuthMode
}): ProviderTurnContext {
  return {
    input: input.input,
    options: input.options,
    installation: input.installation ?? input.input.installation,
    runtimeScope: input.input.providerRuntimeScope,
    controls: {
      runtimeRoot: input.input.runtimeRoot,
      outerSandbox: input.options?.outerSandbox ?? false,
      authMode: input.authMode
    }
  }
}

export interface SandboxPolicyContext {
  readonly installation: ProviderInstallation
  readonly preparedAuth: ProviderAuthPrepared
  readonly hostEnvironment?: HostEnvironmentSnapshot | undefined
}

export interface ProviderSandboxContribution {
  readonly readRoots: readonly string[]
  readonly writeRoots: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly credentialSnapshots: readonly {
    readonly relativePath: string
    readonly required: boolean
  }[]
}

export interface PreparedProviderTurn {
  readonly installation: ProviderInstallation
  readonly reusePolicy: ProviderReusePolicy
  stream(signal?: AbortSignal): AsyncGenerator<AgentTurnChunk>
  cancel(reason: Error): Promise<void>
  close(): Promise<void>
}

export interface ProviderDriver {
  readonly kind: 'production' | 'test-fake'
  readonly descriptor: ProviderDescriptor
  readonly settings: ProviderSettings

  discover(context?: ProviderDiscoveryContext): Promise<ProviderInstallation | null>
  installDirs(hostEnvironment?: HostEnvironmentSnapshot): readonly string[]
  prepareAuth(context: ProviderAuthPreparationContext): ProviderAuthPrepared
  preflight(context: ProviderPreflightContext): void
  supports(profile: ProviderCapabilityProfile): boolean
  prepareTurn(context: ProviderTurnContext): Promise<PreparedProviderTurn>
  contributeSandboxPolicy(context: SandboxPolicyContext): ProviderSandboxContribution
  /** Close protocol-specific shared transports owned under manager-selected scopes. */
  shutdown?(): Promise<void>
}
