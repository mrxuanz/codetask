/** Canonical provider codes shared across main/renderer/server boundaries. */
export const SUPPORTED_CORE_CODES = ['codex', 'claude-code', 'opencode', 'cursorcli'] as const
export type SupportedCoreCode = (typeof SUPPORTED_CORE_CODES)[number]

export const PROVIDER_CODE_ALIASES: Readonly<Record<string, SupportedCoreCode>> = {
  codex: 'codex',
  claude: 'claude-code',
  claude_code: 'claude-code',
  'claude-code': 'claude-code',
  opencode: 'opencode',
  cursor: 'cursorcli',
  'cursor-cli': 'cursorcli',
  'cursor-agent': 'cursorcli',
  cursor_cli: 'cursorcli',
  cursorcli: 'cursorcli'
}

export function isSupportedCoreCode(value: string): value is SupportedCoreCode {
  return (SUPPORTED_CORE_CODES as readonly string[]).includes(value)
}

/** Pure boundary normalizer. Domain layers decide how an unknown value is reported. */
export function normalizeProviderCode(value: string): SupportedCoreCode | null {
  return PROVIDER_CODE_ALIASES[value.trim().toLowerCase()] ?? null
}
