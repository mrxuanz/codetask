/**
 * Compile Provider + Workspace + MCP + resource limits into one effective policy.
 * TypeScript validates; native re-validates (重构.md §10.4).
 */

export type NetworkMode = 'none' | 'restricted' | 'full'

export interface ProviderRuntimeProfileInput {
  readonly providerCode: string
  readonly identityReadRoots?: readonly string[]
  readonly identityWriteRoots?: readonly string[]
  readonly networkMode?: NetworkMode
}

export interface WorkspaceCapabilityInput {
  readonly cwd: string
  readonly runtimeRoot: string
  readonly role?: string
  readonly readRoots?: readonly string[]
  readonly writeRoots?: readonly string[]
}

export interface McpCapabilityInput {
  /** Absolute URLs or host:port endpoints allowed for localhost MCP. */
  readonly allowedEndpoints?: readonly string[]
}

export interface ResourceLimitsInput {
  readonly maxStdoutBytes?: number
  readonly timeoutMs?: number
  readonly maxRuntimeBytes?: number
}

export interface EffectiveSandboxPolicy {
  readonly version: 2
  readonly role: string
  readonly cwd: string
  readonly runtimeRoot: string
  readonly providerCode: string
  readonly filesystem: {
    readonly defaultAccess: 'none'
    readonly allowedReadRoots: string[]
    readonly allowedWriteRoots: string[]
    readonly protectedNames: string[]
    readonly allowSystemRuntime: boolean
  }
  readonly network: {
    readonly mode: NetworkMode
    readonly allowLoopback: boolean
    readonly allowUnixSockets: string[]
    readonly mcpAllowlist: string[]
  }
  readonly process: {
    readonly isolateFromHost: true
    readonly denyPtrace: true
    readonly allowOwnDescendantSignals: true
  }
  readonly limits: {
    readonly maxStdoutBytes: number
    readonly timeoutMs: number | null
    readonly maxRuntimeBytes: number | null
  }
}

const DEFAULT_PROTECTED_NAMES = ['.ssh', '.gnupg', '.aws', '.config'] as const
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024

function uniqueAbsolute(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of paths) {
    const p = raw.trim()
    if (!p) continue
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

export class PolicyCompileError extends Error {
  constructor(
    message: string,
    readonly code: 'runtime.policy.incomplete' | 'runtime.policy.invalid'
  ) {
    super(message)
    this.name = 'PolicyCompileError'
  }
}

/**
 * Merge provider profile, workspace capability, MCP allowlist, and limits.
 * Fail closed when required fields are missing.
 */
export function compileEffectivePolicy(input: {
  readonly provider: ProviderRuntimeProfileInput
  readonly workspace: WorkspaceCapabilityInput
  readonly mcp?: McpCapabilityInput
  readonly limits?: ResourceLimitsInput
}): EffectiveSandboxPolicy {
  const { provider, workspace, mcp, limits } = input

  if (!provider.providerCode?.trim()) {
    throw new PolicyCompileError('providerCode is required', 'runtime.policy.incomplete')
  }
  if (!workspace.cwd?.trim() || !workspace.runtimeRoot?.trim()) {
    throw new PolicyCompileError(
      'workspace cwd and runtimeRoot are required',
      'runtime.policy.incomplete'
    )
  }

  const readRoots = uniqueAbsolute([
    workspace.cwd,
    workspace.runtimeRoot,
    ...(workspace.readRoots ?? []),
    ...(provider.identityReadRoots ?? [])
  ])
  const writeRoots = uniqueAbsolute([
    workspace.runtimeRoot,
    ...(workspace.writeRoots ?? []),
    ...(provider.identityWriteRoots ?? [])
  ])

  const mcpAllowlist = uniqueAbsolute(mcp?.allowedEndpoints ?? [])
  const networkMode = provider.networkMode ?? 'restricted'

  return {
    version: 2,
    role: workspace.role ?? 'task-worker',
    cwd: workspace.cwd,
    runtimeRoot: workspace.runtimeRoot,
    providerCode: provider.providerCode,
    filesystem: {
      defaultAccess: 'none',
      allowedReadRoots: readRoots,
      allowedWriteRoots: writeRoots,
      protectedNames: [...DEFAULT_PROTECTED_NAMES],
      allowSystemRuntime: true
    },
    network: {
      mode: networkMode,
      allowLoopback: mcpAllowlist.length > 0,
      allowUnixSockets: [],
      mcpAllowlist
    },
    process: {
      isolateFromHost: true,
      denyPtrace: true,
      allowOwnDescendantSignals: true
    },
    limits: {
      maxStdoutBytes: limits?.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      timeoutMs: limits?.timeoutMs ?? null,
      maxRuntimeBytes: limits?.maxRuntimeBytes ?? null
    }
  }
}

export function effectivePolicyToJson(policy: EffectiveSandboxPolicy): string {
  return JSON.stringify(policy)
}
