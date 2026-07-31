import type { AgentCapabilityProfile } from '../../agent-runtime/capabilities'
import {
  CLI_READ_ONLY_BUILTINS,
  capabilityProfileIsReadOnly,
  resolveInputCapabilityProfile
} from '../../agent-runtime/capabilities'
import { buildProviderChildEnv, buildSandboxPreparedProviderEnv } from '../../agent-runtime/env'
import { buildClaudeMcpServers } from '../../agent-runtime/mcp'
import { CLI_FULL_ACCESS_BUILTINS, roleRequiresOuterSandbox } from '../../agent-runtime/roles'
import type { AgentTurnInput } from '../../agent-runtime/types'
import type { CommandInvocation } from '../../../shared/providers/installation'
import { createTurnError } from '../../../shared/turn-errors.ts'
import { resolveProviderExecutable } from '../executable'
import {
  resolveProviderExecutableStrategy,
  type ProviderExecutableStrategy
} from '../runtime-executable'
import { resolveClaudeSettingsAuthEnv } from '../../sandbox/provider-auth/paths'
import type {
  PermissionMode as ClaudePermissionMode,
  SandboxSettings as ClaudeSandboxSettings
} from '@anthropic-ai/claude-agent-sdk'

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
 * Outer-sandbox turns load only the host `user` settings source so
 * `~/.claude/settings.json` auth/env can resolve, while skipping project/local
 * policy. Whitelisted settings.env keys are still injected as a belt-and-suspenders
 * path when the shared env stripper removes ANTHROPIC_*.
 * Direct conversation turns load user/project/local; MCP and skills are
 * overridden in streamClaudeTurn.
 */
export function resolveClaudeSettingSources(
  outerSandbox: boolean,
  _capabilityProfile?: AgentCapabilityProfile
): ClaudeSettingSource[] {
  return outerSandbox ? ['user'] : ['user', 'project', 'local']
}

/** Use the SDK-bundled native CLI unless the user explicitly selected a path. */
export function resolveClaudePathOverride(input: AgentTurnInput): {
  readonly pathToClaudeCodeExecutable?: string
  readonly installationId?: string
  readonly executableInvocation?: CommandInvocation
  readonly executableStrategy: ProviderExecutableStrategy
} {
  if (input.installation) {
    const executableStrategy = resolveProviderExecutableStrategy(
      'claude-code',
      input.installation.source
    )
    if (executableStrategy === 'sdk-bundled') {
      return {
        installationId: input.installation.id,
        executableStrategy
      }
    }
    return {
      pathToClaudeCodeExecutable: input.installation.invocation.executable,
      installationId: input.installation.id,
      executableInvocation: input.installation.invocation,
      executableStrategy
    }
  }
  const resolved = resolveProviderExecutable('claude-code')
  if (!resolved) return { executableStrategy: 'sdk-bundled' }
  const executableStrategy = resolveProviderExecutableStrategy('claude-code', resolved.source)
  if (executableStrategy === 'sdk-bundled') {
    return {
      installationId: resolved.installationId,
      executableStrategy
    }
  }
  return {
    pathToClaudeCodeExecutable: resolved.executable,
    installationId: resolved.installationId,
    executableInvocation: {
      executable: resolved.executable,
      prefixArgs: resolved.prefixArgs
    },
    executableStrategy
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
  readonly permissionMode: ClaudePermissionMode
  readonly allowDangerouslySkipPermissions: boolean
  readonly sandbox: ClaudeSandboxSettings
  readonly model?: string | undefined
  readonly resume?: string | undefined
  readonly pathToClaudeCodeExecutable?: string | undefined
  readonly installationId?: string | undefined
  readonly executableInvocation?: CommandInvocation | undefined
  readonly executableStrategy: ProviderExecutableStrategy
}

/**
 * Outer-sandbox turns keep settingSources=['user'] (no project/local), and still
 * re-inject the ANTHROPIC_* / CLAUDE_CODE_OAUTH_TOKEN whitelist after the shared
 * env stripper removes them.
 */
export function applyClaudeSettingsAuthEnv(
  env: Record<string, string>,
  settingsAuthEnv: Readonly<Record<string, string>> = resolveClaudeSettingsAuthEnv()
): Record<string, string> {
  return { ...env, ...settingsAuthEnv }
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
    ? applyClaudeSettingsAuthEnv(buildSandboxPreparedProviderEnv())
    : buildProviderChildEnv(input.runtimeRoot)
  const settingSources = resolveClaudeSettingSources(outerSandbox, capabilityProfile)
  const pinMcpConfig = settingSources.length > 0 || mcpServerNames.length > 0
  const nativeWorkspaceSandbox = !outerSandbox && !readOnly
  const permissionMode: ClaudePermissionMode = nativeWorkspaceSandbox
    ? 'acceptEdits'
    : 'bypassPermissions'

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
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
    sandbox: nativeWorkspaceSandbox
      ? {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          autoAllowBashIfSandboxed: true,
          filesystem: {
            allowWrite: [input.cwd]
          }
        }
      : { enabled: false },
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.runtimeSessionId ? { resume: input.runtimeSessionId } : {}),
    ...pathOverride
  }
}
