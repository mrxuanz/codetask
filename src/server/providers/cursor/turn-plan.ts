import { join } from 'node:path'
import {
  applyTaskIdempotencyEnv,
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv,
  ensureCursorAcpRuntimeDirs,
  stripElectronInheritedEnv
} from '../../agent-runtime/env'
import { buildCursorAcpMcpServers, type CursorAcpMcpServer } from '../../agent-runtime/mcp'
import { resolveProviderOuterSandbox } from '../../agent-runtime/provider-policy'
import type { AgentTurnInput } from '../../agent-runtime/types'
import {
  capabilityProfileIsReadOnly,
  resolveInputCapabilityProfile,
  type AgentCapabilityProfile
} from '../../agent-runtime/capabilities'
import { resolveProviderExecutable } from '../executable'

/**
 * Prefer typed settings / explicit options. No CODETASK_CURSOR_* env fallback (PRU-12-06).
 */
export function resolveCursorApiEndpoint(endpoint?: string): string | undefined {
  const fromOptions = endpoint?.trim()
  return fromOptions || undefined
}

export function appendCursorApiEndpointArgs(args: string[], endpoint?: string): string[] {
  const resolved = resolveCursorApiEndpoint(endpoint)
  if (!resolved) return args
  return ['-e', resolved, ...args]
}

/**
 * Prefer the driver-discovered installation; fall back to the shared resolver so
 * detect and ACP spawn share one path identity (including Windows .cmd shims).
 */
export function resolveCursorPathOverride(input: AgentTurnInput): {
  readonly executable: string
  readonly prefixArgs: readonly string[]
  readonly installationId?: string
} {
  if (input.installation) {
    return {
      executable: input.installation.invocation.executable,
      prefixArgs: input.installation.invocation.prefixArgs,
      installationId: input.installation.id
    }
  }
  const resolved = resolveProviderExecutable('cursorcli')
  if (resolved) {
    return {
      executable: resolved.executable,
      prefixArgs: resolved.prefixArgs,
      installationId: resolved.installationId
    }
  }
  return {
    executable: 'agent',
    prefixArgs: []
  }
}

export function buildCursorAcpCliArgs(input: {
  outerSandbox: boolean
  cwd?: string
  capabilityProfile?: AgentCapabilityProfile
  endpoint?: string | undefined
  approveMcps?: boolean | undefined
}): string[] {
  const approveMcps = input.approveMcps ?? true

  if (!input.outerSandbox) {
    const args: string[] = []
    if (input.capabilityProfile && capabilityProfileIsReadOnly(input.capabilityProfile)) {
      args.push('--mode', 'ask')
    }
    if (
      (!input.capabilityProfile || !capabilityProfileIsReadOnly(input.capabilityProfile)) &&
      approveMcps
    ) {
      args.push('--approve-mcps')
    }
    return appendCursorApiEndpointArgs([...args, 'acp'], input.endpoint)
  }

  const args = ['--trust', '--force', '--sandbox', 'disabled']
  if (approveMcps) {
    args.push('--approve-mcps')
  }
  const cwd = input.cwd?.trim()
  if (cwd) {
    args.push('--workspace', cwd)
  }
  return appendCursorApiEndpointArgs([...args, 'acp'], input.endpoint)
}

function buildCursorHostEnv(runtimeRoot: string, workspaceCwd?: string): Record<string, string> {
  const env = buildProviderChildEnv(runtimeRoot, { preserveHostIdentity: true })
  stripElectronInheritedEnv(env)
  // Scope Cursor project metadata / MCP approvals under the runtime root, not the host profile.
  const cursorDataDir = join(runtimeRoot, '.cursor')
  env.CURSOR_DATA_DIR = cursorDataDir
  ensureCursorAcpRuntimeDirs(runtimeRoot, workspaceCwd)
  return env
}

export interface CursorTurnPlan {
  role: AgentTurnInput['role']
  outerSandbox: boolean
  env: Record<string, string>
  mcpServers: CursorAcpMcpServer[]
  /** Full ACP argv including optional `-e` endpoint — spawn must not re-append. */
  cliArgs: string[]
  capabilityProfile: AgentCapabilityProfile
  readonly executable: string
  readonly prefixArgs: readonly string[]
  readonly installationId: string | undefined
}

/** CursorDriver-owned ACP turn plan builder (PRU-10-05). */
export function buildCursorTurnPlan(
  input: AgentTurnInput,
  options: {
    outerSandbox?: boolean | undefined
    userMcpServers?: Record<string, unknown> | undefined
    endpoint?: string | undefined
    approveMcps?: boolean | undefined
  } = {}
): CursorTurnPlan {
  const outerSandbox = resolveProviderOuterSandbox(input.role, options.outerSandbox)
  const capabilityProfile = resolveInputCapabilityProfile(input)
  const env = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildCursorHostEnv(input.runtimeRoot, input.cwd)
  if (outerSandbox) {
    stripElectronInheritedEnv(env)
    // Outer sandbox still scopes writable Cursor data under runtimeRoot when present.
    if (input.runtimeRoot?.trim()) {
      env.CURSOR_DATA_DIR = join(input.runtimeRoot, '.cursor')
      ensureCursorAcpRuntimeDirs(input.runtimeRoot, input.cwd)
    }
  }
  applyTaskIdempotencyEnv(env, input.idempotencyKey)

  const mcpServers = buildCursorAcpMcpServers(input.mcpUrl, options.userMcpServers ?? {})
  const pathOverride = resolveCursorPathOverride(input)
  const cliArgs = buildCursorAcpCliArgs({
    outerSandbox,
    cwd: input.cwd,
    capabilityProfile,
    endpoint: options.endpoint,
    approveMcps: options.approveMcps
  })

  return {
    role: input.role,
    outerSandbox,
    env,
    mcpServers,
    cliArgs,
    capabilityProfile,
    executable: pathOverride.executable,
    prefixArgs: pathOverride.prefixArgs,
    installationId: pathOverride.installationId
  }
}
