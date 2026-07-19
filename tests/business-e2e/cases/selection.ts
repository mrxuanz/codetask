/**
 * Human-facing suite selection for business e2e.
 * Prefer --part / --case <slug> / npm scripts — not G0/G6-style ids in day-to-day use.
 * Legacy --gate G* and --case G* remain as deprecated aliases.
 * Labels: see i18n/messages.ts (--lang zh|en|ja).
 */

import { tCase, tPart, tStep } from '../i18n'

export type AcceptancePart = 'bootstrap' | 'conversation' | 'draft-job' | 'settings-mcp'

/** Friendly slug → internal catalog caseId */
export const CASE_ALIASES: Record<string, string> = {
  // bootstrap / smoke building blocks
  'build-artifact': 'G0-001',
  'server-health': 'G0-002',
  'isolated-dirs': 'G0-003',
  'isolated-port': 'G0-004',
  'single-server': 'G0-005',
  'worker-crash': 'G0-006',
  setup: 'G1-003',
  'auth-bearer': 'G1-007',
  'token-redaction': 'G1-008',
  'project-thread': 'G2-001',

  // Part A — normal conversation
  'chat-basic': 'G3-001',
  'chat-create-html': 'CHAT-HTML-001',

  // Part B — draft → execution tree → job (one chain)
  foundation: 'FOUNDATION-FAKE-001',
  'draft-fuzzy': 'G4-001',
  'draft-staged': 'G4-002',
  'draft-fields': 'G4-003',
  'draft-confirm': 'G4-012',
  'draft-multiturn': 'DRAFT-MULTITURN-001',
  'notes-search': 'G6-001',
  'notes-search-oracle-trap': 'G6-002',
  'job-chat-readonly': 'JOB-CHAT-RO-001',

  // Phase 3 — settings user MCP (conversation / task / verification)
  'settings-mcp-probe': 'SETTINGS-MCP-001',

  // full scripted probe (`fixed-opencode-chain` retained as a legacy alias)
  'fixed-opencode-chain': 'G8-001',
  'full-chain': 'G8-001'
}

/** Internal id → preferred slug (for CLI / machine logs) */
export const CASE_SLUG_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(CASE_ALIASES).map(([slug, id]) => [id, slug])
)

export function slugForCaseId(caseId: string): string {
  return CASE_SLUG_BY_ID[caseId] ?? caseId
}

/** Stdout label: localized case name (never print bare G6-001 as scope). */
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
  if (caseId.startsWith('G3') || caseId.startsWith('CHAT')) return 'conversation'
  if (caseId.startsWith('SETTINGS-MCP') || caseId.startsWith('SETTINGS')) return 'settings-mcp'
  if (caseId.startsWith('JOB-CHAT')) return 'draft-job'
  if (
    caseId.startsWith('G4') ||
    caseId.startsWith('G5') ||
    caseId.startsWith('G6') ||
    caseId.startsWith('DRAFT') ||
    caseId.startsWith('FOUNDATION')
  ) {
    return 'draft-job'
  }
  if (caseId.startsWith('G0') || caseId.startsWith('G1') || caseId.startsWith('G2')) {
    return 'bootstrap'
  }
  return null
}

/** e.g. 段B·草案执行树任务 / 笔记搜索·完整闭环 */
export function scopeLabelForCaseId(caseId: string): string {
  const part = partForCaseId(caseId)
  const caseLabel = labelForCaseId(caseId)
  if (part) return `${labelForPart(part)} / ${caseLabel}`
  return caseLabel
}

export const PART_DEFAULT_CASES: Record<AcceptancePart, string[]> = {
  // Infrastructure smoke used before A/B depth
  bootstrap: [
    'G0-001',
    'G0-002',
    'G0-003',
    'G0-004',
    'G0-005',
    'G1-003',
    'G1-007',
    'G1-008',
    'G0-006',
    'G2-001'
  ],
  // Part A: basic chat + create SDK-named HTML
  conversation: ['G3-001', 'CHAT-HTML-001'],
  // Part B depth: Notes Search + job-time chat readonly thicken
  'draft-job': ['G6-001', 'JOB-CHAT-RO-001'],
  // Phase 3: settings user MCP probe
  'settings-mcp': ['SETTINGS-MCP-001']
}

export const SUITE_ALIASES: Record<string, { parts?: AcceptancePart[]; caseIds?: string[] }> = {
  smoke: {
    caseIds: [
      'G0-001',
      'G0-002',
      'G0-003',
      'G0-004',
      'G0-005',
      'G1-003',
      'G1-007',
      'G1-008',
      'G0-006',
      'G2-001',
      'G3-001'
    ]
  },
  conversation: { parts: ['conversation'] },
  chat: { parts: ['conversation'] },
  'draft-job': { parts: ['draft-job'] },
  draft: { parts: ['draft-job'] },
  job: { parts: ['draft-job'] },
  both: { parts: ['conversation', 'draft-job'] },
  'a-b': { parts: ['conversation', 'draft-job'] },
  phases: { parts: ['conversation', 'draft-job', 'settings-mcp'] },
  'settings-mcp': { parts: ['settings-mcp'] },
  mcp: { parts: ['settings-mcp'] },
  all: { parts: ['bootstrap', 'conversation', 'draft-job', 'settings-mcp'] }
}

const LEGACY_GATE_HINT: Record<string, string> = {
  G0: 'bootstrap (prefer --part bootstrap)',
  G1: 'bootstrap (prefer --part bootstrap)',
  G2: 'bootstrap (prefer --part bootstrap)',
  G3: 'conversation (prefer --part conversation)',
  G4: 'draft-job surface (prefer --part draft-job or --case notes-search)',
  G5: 'draft-job surface (prefer --part draft-job or --case notes-search)',
  G6: 'draft-job (prefer --part draft-job or --case notes-search)',
  G7: 'post / realtime (no friendly suite yet)',
  G8: 'post / full (prefer --suite both then expand)'
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
    if (piece === 'b' || piece === 'draft-job' || piece === 'draft' || piece === 'job') {
      out.push('draft-job')
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
      `unknown_part:${piece}:use conversation|draft-job|settings-mcp|bootstrap (or a,b,c)`
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
    if (/^G\d/i.test(input.caseId) && CASE_SLUG_BY_ID[resolved]) {
      warnings.push(`deprecated_case_id:${input.caseId}:prefer --case ${CASE_SLUG_BY_ID[resolved]}`)
    } else if (/^G\d/i.test(input.caseId)) {
      warnings.push(`deprecated_case_id:${input.caseId}:prefer friendly --case slugs (see --list)`)
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
      throw new Error(
        `unknown_suite:${suiteKey}:use smoke|conversation|draft-job|both|all (not G4/G6)`
      )
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
      'draft-job': 'draft-job',
      draft: 'draft-job',
      job: 'draft-job',
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
    if (LEGACY_GATE_HINT[gate]) {
      warnings.push(`deprecated_gate:${gate}:${LEGACY_GATE_HINT[gate]}`)
    } else if (/^G\d/i.test(gate)) {
      warnings.push(`deprecated_gate:${gate}:prefer --part conversation|draft-job or --suite smoke`)
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
  const lines = [
    'Cases (--case <slug>; labels follow --lang zh|en|ja):',
    ...Object.entries(CASE_ALIASES).map(([slug, id]) => {
      const label = labelForCaseId(id)
      return `  ${slug.padEnd(28)} ${label}`
    }),
    '',
    'Parts / phases (--part):',
    `  conversation   ${labelForPart('conversation')}  (phase 1)`,
    `  draft-job      ${labelForPart('draft-job')}  (phase 2)`,
    `  settings-mcp   ${labelForPart('settings-mcp')}  (phase 3)`,
    `  bootstrap      ${labelForPart('bootstrap')}`,
    '',
    'Suites (--suite):',
    '  smoke | conversation | draft-job | both | phases | all',
    '',
    'Providers (--providers):',
    '  opencode | cursor | claude | codex | all',
    '',
    'Language: --lang zh|en|ja  (or BUSINESS_E2E_LANG)'
  ]
  return lines.join('\n')
}
