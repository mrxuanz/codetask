import type { AgentCapabilityProfile } from '../capabilities'

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
