import type { AgentCapabilityProfile } from '../../agent-runtime/capabilities'
import {
  CLI_READ_ONLY_BUILTINS,
  capabilityProfileIsReadOnly,
  resolveInputCapabilityProfile
} from '../../agent-runtime/capabilities'
import {
  applyTaskIdempotencyEnv,
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv
} from '../../agent-runtime/env'
import { buildClaudeMcpServers } from '../../agent-runtime/mcp'
import { CLI_FULL_ACCESS_BUILTINS, roleRequiresOuterSandbox } from '../../agent-runtime/roles'
import type { AgentTurnInput } from '../../agent-runtime/types'
import type { CommandInvocation } from '../../../shared/providers/installation'
import { createTurnError } from '../../../shared/turn-errors.ts'
import { resolveProviderExecutable } from '../executable'

export type ClaudeSettingSource = 'user' | 'project' | 'local'

export type ClaudeSystemPrompt =
  | string
  | {
      type: 'preset'
      preset: 'claude_code'
      append?: string
    }

/**
 * Always use the Claude Code preset so the SDK injects working-directory /
 * project context. A bare string replaces the preset entirely and models may
 * ignore `options.cwd` (especially on Windows conversation turns).
 */
export function resolveClaudeSystemPrompt(systemPrompt?: string): ClaudeSystemPrompt {
  const append = systemPrompt?.trim()
  if (append) {
    return { type: 'preset', preset: 'claude_code', append }
  }
  return { type: 'preset', preset: 'claude_code' }
}

/**
 * Outer-sandbox turns isolate via runtime-copy auth and must not load host
 * CLAUDE.md / skills / hooks. Direct conversation turns (including read-only)
 * load user/project/local settings so host `settings.json` env auth and model
 * defaults stay available; MCP and skills are overridden in streamClaudeTurn.
 */
export function resolveClaudeSettingSources(
  outerSandbox: boolean,
  _capabilityProfile?: AgentCapabilityProfile
): ClaudeSettingSource[] {
  return outerSandbox ? [] : ['user', 'project', 'local']
}

/**
 * Prefer the driver-discovered installation; fall back to the shared resolver so
 * detect and SDK launch share one path identity.
 */
export function resolveClaudePathOverride(input: AgentTurnInput): {
  readonly pathToClaudeCodeExecutable?: string
  readonly installationId?: string
  readonly executableInvocation?: CommandInvocation
} {
  if (input.installation) {
    return {
      pathToClaudeCodeExecutable: input.installation.invocation.executable,
      installationId: input.installation.id,
      executableInvocation: input.installation.invocation
    }
  }
  const resolved = resolveProviderExecutable('claude-code')
  if (!resolved) return {}
  return {
    pathToClaudeCodeExecutable: resolved.executable,
    installationId: resolved.installationId,
    executableInvocation: {
      executable: resolved.executable,
      prefixArgs: resolved.prefixArgs
    }
  }
}

export interface ClaudeTurnOptionsPlan {
  readonly outerSandbox: boolean
  readonly readOnly: boolean
  readonly builtins: readonly string[]
  readonly allowedTools: readonly string[]
  readonly disallowedTools: readonly string[]
  readonly settingSources: readonly ClaudeSettingSource[]
  readonly systemPrompt: ClaudeSystemPrompt
  readonly env: Record<string, string>
  readonly mcpServers: Record<string, unknown>
  readonly pinMcpConfig: boolean
  readonly model?: string | undefined
  readonly resume?: string | undefined
  readonly pathToClaudeCodeExecutable?: string | undefined
  readonly installationId?: string | undefined
  readonly executableInvocation?: CommandInvocation | undefined
}

/** ClaudeDriver-owned turn options builder (PRU-08-05). */
export function buildClaudeTurnOptions(
  input: AgentTurnInput,
  options: { outerSandbox?: boolean | undefined } = {}
): ClaudeTurnOptionsPlan {
  const outerSandbox = options.outerSandbox ?? false
  if (!outerSandbox && roleRequiresOuterSandbox(input.role)) {
    throw createTurnError('sandbox.required', {
      detail: 'Claude bypassPermissions requires OS outer sandbox'
    })
  }

  const capabilityProfile = resolveInputCapabilityProfile(input)
  const readOnly = capabilityProfileIsReadOnly(capabilityProfile)
  const builtins = readOnly ? [...CLI_READ_ONLY_BUILTINS] : [...CLI_FULL_ACCESS_BUILTINS]
  const userMcpServers = input.userMcpServers ?? {}
  const mcpServers = buildClaudeMcpServers(input.mcpUrl, userMcpServers)
  const mcpServerNames = Object.keys(mcpServers)
  const mcpToolAllowlist = mcpServerNames.map((name) => `mcp__${name}__*`)
  const allowedTools = mcpToolAllowlist.length > 0 ? [...builtins, ...mcpToolAllowlist] : builtins
  const pathOverride = resolveClaudePathOverride(input)

  const env = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildProviderChildEnv(input.runtimeRoot, { preserveHostIdentity: true })
  applyTaskIdempotencyEnv(env, input.idempotencyKey)

  const settingSources = resolveClaudeSettingSources(outerSandbox, capabilityProfile)
  const pinMcpConfig = settingSources.length > 0 || mcpServerNames.length > 0

  return {
    outerSandbox,
    readOnly,
    builtins,
    allowedTools,
    disallowedTools: readOnly
      ? ['AskUserQuestion', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent']
      : ['AskUserQuestion'],
    settingSources,
    systemPrompt: resolveClaudeSystemPrompt(input.systemPrompt),
    env,
    mcpServers,
    pinMcpConfig,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.runtimeSessionId ? { resume: input.runtimeSessionId } : {}),
    ...pathOverride
  }
}
