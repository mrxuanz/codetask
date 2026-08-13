import type { CaseManifest } from '../cases/catalog'

export const LIVE_OPERATOR_CODES = ['opencode', 'codex', 'claude', 'cursor'] as const

export type LiveOperatorCode = (typeof LIVE_OPERATOR_CODES)[number]
export type OperatorCode = LiveOperatorCode | 'fake'
export type OperatorSelection = OperatorCode | 'manifest'
export type OperatorProtocol = 'sdk' | 'acp' | 'local-server' | 'scripted'
export type ResolvedCaseDriver = 'supervisor' | OperatorCode

export const OPERATOR_PROTOCOLS: Readonly<Record<OperatorCode, OperatorProtocol>> = {
  opencode: 'local-server',
  codex: 'sdk',
  claude: 'sdk',
  cursor: 'acp',
  fake: 'scripted'
}

export function normalizeOperator(raw: string): OperatorSelection {
  const value = raw.trim().toLowerCase()
  if (!value || value === 'manifest' || value === 'default') return 'manifest'
  if (value === 'fake' || value === 'scripted') return 'fake'
  if (value === 'opencode' || value === 'oc' || value === 'opencode-sdk') return 'opencode'
  if (value === 'codex' || value === 'codex-sdk') return 'codex'
  if (value === 'claude' || value === 'claude-sdk' || value === 'claude-code') return 'claude'
  if (value === 'cursor' || value === 'cursor-acp' || value === 'acp') return 'cursor'
  throw new Error(`unknown_operator:${raw}:use manifest|fake|opencode|codex|claude|cursor`)
}

/**
 * `--operator` is the canonical flag. `--driver` remains a concise alias because
 * the E2E implementation has historically called the outer actor a driver.
 */
export function resolveOperatorSelection(input: {
  operator?: string
  driver?: string
}): OperatorSelection {
  const operator = input.operator?.trim() ? normalizeOperator(input.operator) : null
  const driver = input.driver?.trim() ? normalizeOperator(input.driver) : null
  if (operator && driver && operator !== driver) {
    throw new Error(`operator_flag_conflict:${operator}:${driver}`)
  }
  return operator ?? driver ?? 'manifest'
}

/** Supervisor cases always stay in-process. Explicit selection overrides every
 * other scenario, which lets the same scenario be exercised by SDK, ACP, or the
 * deterministic scripted actor. `manifest` preserves the catalog default.
 */
export function resolveCaseDriver(
  manifestDriver: CaseManifest['driver'],
  selection: OperatorSelection
): ResolvedCaseDriver {
  if (manifestDriver === 'supervisor') return 'supervisor'
  if (selection === 'manifest') return manifestDriver
  return selection
}
