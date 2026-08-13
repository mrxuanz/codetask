/**
 * Human-facing suite selection for business e2e.
 * Prefer --part / --case <business-slug> / npm scripts.
 * Labels: see i18n/messages.ts (--lang zh|en|ja).
 */

import { tCase, tPart, tStep } from '../i18n'
import { MANIFESTS, type CaseGate } from './catalog'

export type AcceptancePart = CaseGate

/** Supervisor/infra cases share one server auth — run once, not per --providers slot. */
export function partitionProviderScopedCases(caseIds: readonly string[]): {
  sharedOnce: string[]
  perProvider: string[]
} {
  const sharedOnce: string[] = []
  const perProvider: string[] = []
  for (const id of caseIds) {
    if (MANIFESTS[id]?.driver === 'supervisor') sharedOnce.push(id)
    else perProvider.push(id)
  }
  return { sharedOnce, perProvider }
}

/** Short compatibility aliases → canonical business case id. */
export const CASE_ALIASES: Record<string, string> = {
  setup: 'setup-login',
  'project-thread': 'project-conversation',
  foundation: 'foundation-probe',
  'design-draft': 'design-draft-confirm',
  'draft-confirm': 'design-draft-confirm'
}

/** Canonical ids are already readable slugs; keep this map for report callers. */
export const CASE_SLUG_BY_ID: Record<string, string> = Object.fromEntries(
  Object.keys(MANIFESTS).map((id) => [id, id])
)

export function slugForCaseId(caseId: string): string {
  return CASE_SLUG_BY_ID[caseId] ?? caseId
}

/** Stdout label: localized business case name. */
export function labelForCaseId(caseId: string): string {
  const label = tCase(caseId)
  return label !== caseId ? label : slugForCaseId(caseId)
}

export function labelForPart(part: AcceptancePart): string {
  return tPart(part)
}

export function labelForStep(step: string): string {
  return tStep(step)
}

export function partForCaseId(caseId: string): AcceptancePart | null {
  return MANIFESTS[caseId]?.gate ?? null
}

/** e.g. 段B·设计草案确认 / 设计草案·对话澄清后确认 */
export function scopeLabelForCaseId(caseId: string): string {
  const part = partForCaseId(caseId)
  const caseLabel = labelForCaseId(caseId)
  if (part) return `${labelForPart(part)} / ${caseLabel}`
  return caseLabel
}

export const PART_DEFAULT_CASES: Record<AcceptancePart, string[]> = {
  // Infrastructure smoke used before A/B depth
  bootstrap: [
    'build-artifact',
    'server-health',
    'isolated-dirs',
    'isolated-port',
    'single-server',
    'setup-login',
    'auth-bearer',
    'token-redaction',
    'worker-crash',
    'project-conversation'
  ],
  // Part A / phase 1: ordinary chat (+ attachment when Asset Store lands)
  conversation: ['chat-basic', 'chat-create-html', 'chat-image-attachment'],
  // Part B: Design draft smoke
  design: ['design-draft-confirm'],
  // Phase 3: settings user MCP probe
  'settings-mcp': ['settings-mcp-probe']
}

export const SUITE_ALIASES: Record<string, { parts?: AcceptancePart[]; caseIds?: string[] }> = {
  smoke: {
    caseIds: [...PART_DEFAULT_CASES.bootstrap, 'chat-basic']
  },
  conversation: { parts: ['conversation'] },
  chat: { parts: ['conversation'] },
  design: { parts: ['design'] },
  draft: { parts: ['design'] },
  both: { parts: ['conversation', 'design'] },
  'a-b': { parts: ['conversation', 'design'] },
  phases: { parts: ['conversation', 'design', 'settings-mcp'] },
  'settings-mcp': { parts: ['settings-mcp'] },
  mcp: { parts: ['settings-mcp'] },
  // Every catalog case (including foundation). Job execution e2e was removed in architecture 03.
  all: {
    caseIds: [
      ...PART_DEFAULT_CASES.bootstrap,
      'foundation-probe',
      ...PART_DEFAULT_CASES.conversation,
      ...PART_DEFAULT_CASES.design,
      ...PART_DEFAULT_CASES['settings-mcp']
    ]
  }
}

export function resolveInternalCaseId(raw: string): string {
  const key = raw.trim()
  if (CASE_ALIASES[key]) return CASE_ALIASES[key]
  const lower = key.toLowerCase()
  if (CASE_ALIASES[lower]) return CASE_ALIASES[lower]
  return key
}

export function parseParts(raw: string | undefined): AcceptancePart[] {
  if (!raw?.trim()) return []
  const out: AcceptancePart[] = []
  for (const piece of raw
    .split(/[,+\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)) {
    if (piece === 'a' || piece === 'conversation' || piece === 'chat') {
      out.push('conversation')
      continue
    }
    if (piece === 'b' || piece === 'design' || piece === 'draft') {
      out.push('design')
      continue
    }
    if (piece === 'bootstrap' || piece === 'infra') {
      out.push('bootstrap')
      continue
    }
    if (
      piece === 'settings-mcp' ||
      piece === 'mcp' ||
      piece === 'c' ||
      piece === 'phase3' ||
      piece === '3'
    ) {
      out.push('settings-mcp')
      continue
    }
    throw new Error(
      `unknown_part:${piece}:use conversation|design|settings-mcp|bootstrap (or a,b,c)`
    )
  }
  return [...new Set(out)]
}

export type SelectionInput = {
  part?: string
  suite?: string
  caseId?: string
  /** @deprecated use --part / --suite */
  gate?: string
}

export type SelectionResult = {
  caseIds: string[]
  part: AcceptancePart[] | null
  suite: string | null
  warnings: string[]
  /** When set, caller should use catalog.resolveCaseIds({ gate }) */
  legacyGate?: string
}

export function resolveSelection(input: SelectionInput): SelectionResult {
  const warnings: string[] = []
  const parts = parseParts(input.part)
  const suiteKey = input.suite?.trim().toLowerCase()

  if (input.caseId) {
    const resolved = resolveInternalCaseId(input.caseId)
    if (!MANIFESTS[resolved]) {
      throw new Error(`unknown_case:${input.caseId}:use --list for valid case slugs`)
    }
    return {
      caseIds: [resolved],
      part: parts.length ? parts : null,
      suite: suiteKey ?? null,
      warnings
    }
  }

  if (suiteKey) {
    const suite = SUITE_ALIASES[suiteKey]
    if (!suite) {
      throw new Error(`unknown_suite:${suiteKey}:use smoke|conversation|design|both|all`)
    }
    if (suite.caseIds) {
      return { caseIds: [...suite.caseIds], part: null, suite: suiteKey, warnings }
    }
    const fromParts = (suite.parts ?? []).flatMap((p) => PART_DEFAULT_CASES[p])
    return {
      caseIds: [...new Set(fromParts)],
      part: suite.parts ?? null,
      suite: suiteKey,
      warnings
    }
  }

  if (parts.length) {
    const caseIds = [...new Set(parts.flatMap((p) => PART_DEFAULT_CASES[p]))]
    return { caseIds, part: parts, suite: null, warnings }
  }

  if (input.gate) {
    const gate = input.gate.trim()
    // Map friendly gate synonyms that people might type
    const gateAlias: Record<string, string> = {
      conversation: 'conversation',
      chat: 'conversation',
      design: 'design',
      draft: 'design',
      'settings-mcp': 'settings-mcp',
      mcp: 'settings-mcp',
      phases: 'phases',
      smoke: 'smoke',
      both: 'both',
      all: 'all'
    }
    const mapped = gateAlias[gate.toLowerCase()]
    if (mapped && SUITE_ALIASES[mapped]) {
      return resolveSelection({ suite: mapped })
    }
    if (/^G\d/i.test(gate)) {
      throw new Error(`legacy_gate_removed:${gate}:use --part or --suite with business names`)
    }
    return { caseIds: [], part: null, suite: null, warnings, legacyGate: gate }
  }

  // Default: smoke (same as historical default)
  return {
    caseIds: [...SUITE_ALIASES.smoke.caseIds!],
    part: null,
    suite: 'smoke',
    warnings
  }
}

export function formatCaseList(): string {
  const preferredEntries = Object.keys(MANIFESTS).map((id) => [slugForCaseId(id), id] as const)
  const lines = [
    'Cases (--case <slug>; labels follow --lang zh|en|ja):',
    ...preferredEntries.map(([slug, id]) => {
      const label = labelForCaseId(id)
      return `  ${slug.padEnd(28)} ${label}`
    }),
    '',
    'Parts / phases (--part):',
    `  conversation   ${labelForPart('conversation')}  (phase 1)`,
    `  design         ${labelForPart('design')}  (phase 2)`,
    `  settings-mcp   ${labelForPart('settings-mcp')}  (phase 3)`,
    `  bootstrap      ${labelForPart('bootstrap')}`,
    '',
    'Suites (--suite):',
    '  smoke | conversation | design | both | phases | all',
    '  all = bootstrap + foundation + conversation + design + settings-mcp',
    '',
    'Providers (--providers):',
    '  opencode | cursor | claude | codex | all',
    '',
    'Outer operator (--operator; --driver is an alias):',
    '  manifest | fake | opencode(local-server) | codex(SDK) | claude(SDK) | cursor(ACP)',
    '  operator = who operates CodeTask; providers = the SDK/ACP core inside CodeTask',
    '',
    'Language: --lang zh|en|ja  (or BUSINESS_E2E_LANG)'
  ]
  return lines.join('\n')
}
