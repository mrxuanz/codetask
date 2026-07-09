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

export function resolveClaudeSettingSources(outerSandbox: boolean): ClaudeSettingSource[] {
  return outerSandbox ? [] : ['user', 'project', 'local']
}
