export type ClaudeSettingSource = 'user' | 'project' | 'local'

export function resolveClaudeSettingSources(outerSandbox: boolean): ClaudeSettingSource[] {
  return outerSandbox ? [] : ['user', 'project', 'local']
}
