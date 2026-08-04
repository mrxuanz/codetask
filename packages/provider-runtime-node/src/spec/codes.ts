/** Canonical provider codes shared across server/renderer boundaries. */
export const SUPPORTED_CORE_CODES = ['codex', 'claude', 'opencode', 'cursor'] as const
export type SupportedCoreCode = (typeof SUPPORTED_CORE_CODES)[number]

/** Historical input aliases → canonical codes. Write paths must store canonical only. */
export const PROVIDER_CODE_ALIASES: Readonly<Record<string, SupportedCoreCode>> = {
  codex: 'codex',
  claude: 'claude',
  claude_code: 'claude',
  'claude-code': 'claude',
  opencode: 'opencode',
  cursor: 'cursor',
  'cursor-cli': 'cursor',
  'cursor-agent': 'cursor',
  cursor_cli: 'cursor',
  cursorcli: 'cursor'
}

export function isSupportedCoreCode(value: string): value is SupportedCoreCode {
  return (SUPPORTED_CORE_CODES as readonly string[]).includes(value)
}

/** Pure boundary normalizer. Domain layers decide how an unknown value is reported. */
export function normalizeProviderCode(value: string): SupportedCoreCode | null {
  return PROVIDER_CODE_ALIASES[value.trim().toLowerCase()] ?? null
}
