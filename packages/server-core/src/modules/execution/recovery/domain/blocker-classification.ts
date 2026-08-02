export type BlockerKind =
  | 'infra'
  | 'dependency-prep'
  | 'dependency-human'
  | 'decision'
  | 'implementation'

export function classifyBlocker(message: string): BlockerKind {
  const lower = message.toLowerCase()
  if (lower.includes('infra') || lower.includes('timeout')) return 'infra'
  if (lower.includes('dependency') && lower.includes('human')) return 'dependency-human'
  if (lower.includes('dependency')) return 'dependency-prep'
  if (lower.includes('decision')) return 'decision'
  return 'implementation'
}
