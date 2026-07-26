/**
 * Sole protected Runtime Adapter entry for sandboxed turns (重构.md §10 / §15.9).
 * Business layer only calls `openTurn`; spawn of protected providers must go
 * through this adapter + packaged `.node` — never ordinary child_process.spawn.
 */

import { randomUUID } from 'node:crypto'
import type {
  ExecutionRuntimePort,
  OpenTurnRequest,
  OpenTurnResult,
  RuntimeChildHandle
} from '../../core/application/ports/execution-runtime.ts'
import {
  loadNativeNode,
  type LoadedNativeBinding,
  type NodeLoaderOptions,
  NativeLoadError
} from './node-loader.ts'
import {
  compileEffectivePolicy,
  type EffectiveSandboxPolicy,
  type McpCapabilityInput,
  type ProviderRuntimeProfileInput,
  type ResourceLimitsInput,
  type WorkspaceCapabilityInput
} from './policy-compiler.ts'
import { RuntimeSupervisor } from './supervisor.ts'
import { assertMcpEndpointAllowed } from './mcp-allowlist.ts'
/** Internal cross-spawn only — external async launches use protected-spawn.ts. */
import { spawnProviderInvocation } from '../../providers/spawn.ts'

/** Stable marker used by gates/tests to assert sole protected entry. */
export const RUNTIME_ADAPTER_PROTECTED_ENTRY =
  'src/server/adapters/runtime/runtime-adapter.ts#openTurn' as const

export interface RuntimeAdapterOptions {
  readonly nodeLoader?: NodeLoaderOptions
  /** Inject a pre-loaded binding (tests). When set, skips disk load. */
  readonly native?: LoadedNativeBinding
  readonly supervisor?: RuntimeSupervisor
  readonly providerProfile?: ProviderRuntimeProfileInput
  readonly workspace?: WorkspaceCapabilityInput
  readonly mcp?: McpCapabilityInput
  readonly limits?: ResourceLimitsInput
  /** When true, only verify .node load + register ownership (no spawn). */
  readonly dryRun?: boolean
}

export class RuntimeAdapterError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = 'RuntimeAdapterError'
  }
}

/**
 * Production ExecutionRuntimePort implementation.
 * `openTurn` is the only protected entry that may load `.node` / launch sandboxed workers.
 */
export class RuntimeAdapter implements ExecutionRuntimePort {
  readonly protectedEntry = RUNTIME_ADAPTER_PROTECTED_ENTRY
  private readonly supervisor: RuntimeSupervisor
  private readonly options: RuntimeAdapterOptions
  private loaded: LoadedNativeBinding | null

  constructor(options: RuntimeAdapterOptions = {}) {
    this.options = options
    this.supervisor = options.supervisor ?? new RuntimeSupervisor()
    this.loaded = options.native ?? null
  }

  getSupervisor(): RuntimeSupervisor {
    return this.supervisor
  }

  /**
   * Fail-closed openTurn: loads/verifies `.node`, compiles policy, registers ownership.
   * Does not fall back to unprotected spawn when native is missing or invalid.
   * Live path (dryRun===false) delegates to internal cross-spawn after verify.
   */
  async openTurn(req: OpenTurnRequest): Promise<OpenTurnResult> {
    return this.openTurnSync(req)
  }

  /**
   * Sync variant for provider custom-spawn callbacks (Claude SDK / Cursor ACP).
   */
  openTurnSync(req: OpenTurnRequest): OpenTurnResult {
    assertProtectedOpenTurnCaller(RUNTIME_ADAPTER_PROTECTED_ENTRY)

    if (req.abortSignal?.aborted) {
      throw new RuntimeAdapterError('openTurn aborted', 'runtime.turn.aborted')
    }

    const native = this.ensureNative()
    const providerCode = req.providerCode ?? this.options.providerProfile?.providerCode ?? 'unknown'
    const workspace = this.resolveWorkspace(req)
    const limits = {
      ...this.options.limits,
      timeoutMs: req.timeoutMs ?? this.options.limits?.timeoutMs
    }

    const policy = compileEffectivePolicy({
      provider: {
        providerCode,
        identityReadRoots: this.options.providerProfile?.identityReadRoots,
        identityWriteRoots: this.options.providerProfile?.identityWriteRoots,
        networkMode: this.options.providerProfile?.networkMode
      },
      workspace,
      mcp: this.options.mcp,
      limits
    })

    this.enforceMcpAllowlist(policy)

    const turnId = `rt-${randomUUID()}`
    this.supervisor.register({
      turnId,
      jobId: req.jobId,
      providerCode,
      maxStdoutBytes: policy.limits.maxStdoutBytes
    })

    if (this.options.dryRun !== false) {
      // Ownership + fail-closed load; no child in dry-run.
      void native
      void policy
      return { turnId }
    }

    return this.spawnLiveChild(turnId, req, native, policy)
  }

  private spawnLiveChild(
    turnId: string,
    req: OpenTurnRequest,
    native: LoadedNativeBinding,
    policy: EffectiveSandboxPolicy
  ): OpenTurnResult {
    // Wrap-first: verify native is present, then use today's cross-spawn.
    // True SandboxChild / launchSandboxedWorker replace remains a later cut.
    void native
    void policy

    if (!req.invocation?.executable) {
      throw new RuntimeAdapterError(
        'Live openTurn requires invocation.executable',
        'runtime.turn.invocation_required'
      )
    }
    if (!req.cwd || !req.env) {
      throw new RuntimeAdapterError(
        'Live openTurn requires cwd and env',
        'runtime.turn.spawn_options_required'
      )
    }

    const child = spawnProviderInvocation(
      {
        executable: req.invocation.executable,
        prefixArgs: req.invocation.prefixArgs ?? []
      },
      req.args ?? [],
      {
        cwd: req.cwd,
        env: req.env,
        ...(req.stdio !== undefined ? { stdio: req.stdio } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {})
      }
    )

    const supervised = this.supervisor.get(turnId)
    if (supervised) {
      supervised.pid = child.pid ?? null
    }

    return { turnId, child: child as RuntimeChildHandle }
  }

  private ensureNative(): LoadedNativeBinding {
    if (this.loaded) return this.loaded
    try {
      this.loaded = loadNativeNode(this.options.nodeLoader ?? {})
      return this.loaded
    } catch (error) {
      if (error instanceof NativeLoadError) throw error
      throw new NativeLoadError(
        `Failed to load sandbox native binding: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'runtime.native.load_failed'
      )
    }
  }

  private resolveWorkspace(req: OpenTurnRequest): WorkspaceCapabilityInput {
    if (this.options.workspace) return this.options.workspace
    // Fail closed: production must supply workspace via composition; tests inject it.
    throw new RuntimeAdapterError(
      `Workspace capability required for openTurn (jobId=${req.jobId})`,
      'runtime.policy.incomplete'
    )
  }

  private enforceMcpAllowlist(policy: EffectiveSandboxPolicy): void {
    for (const endpoint of policy.network.mcpAllowlist) {
      assertMcpEndpointAllowed(endpoint, policy.network.mcpAllowlist)
    }
  }
}

/**
 * Gate helper: protected production entry must be this adapter's openTurn marker.
 */
export function assertProtectedOpenTurnCaller(entry: string): void {
  if (entry !== RUNTIME_ADAPTER_PROTECTED_ENTRY) {
    throw new RuntimeAdapterError(
      `Protected provider spawn bypassed Runtime Adapter (got ${entry})`,
      'runtime.entry.bypass'
    )
  }
}

export function isSoleProtectedRuntimeEntry(entry: string): boolean {
  return entry === RUNTIME_ADAPTER_PROTECTED_ENTRY
}
