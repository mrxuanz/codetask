/**
 * Human-facing suite selection for business e2e.
 * Prefer --part / --case <slug> / npm scripts — not G0/G6-style ids in day-to-day use.
 * Legacy --gate G* and --case G* remain as deprecated aliases.
 */

export type AcceptancePart = 'bootstrap' | 'conversation' | 'draft-job'

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

  // Part B — draft → execution tree → job (one chain)
  foundation: 'FOUNDATION-FAKE-001',
  'draft-fuzzy': 'G4-001',
  'draft-staged': 'G4-002',
  'draft-fields': 'G4-003',
  'draft-confirm': 'G4-012',
  'draft-multiturn': 'DRAFT-MULTITURN-001',
  'notes-search': 'G6-001',
  'notes-search-oracle-trap': 'G6-002',

  // full scripted probe (legacy surface)
  'fixed-opencode-chain': 'G8-001'
}

/** Internal id → preferred slug (for CLI / machine logs) */
export const CASE_SLUG_BY_ID: Record<string, string> = Object.fromEntries(
  Object.entries(CASE_ALIASES).map(([slug, id]) => [id, slug])
)

/** Human display labels (Chinese for now; swap to EN later). */
export const PART_LABEL_ZH: Record<AcceptancePart, string> = {
  bootstrap: '前置·基础设施',
  conversation: '段A·普通对话',
  'draft-job': '段B·草案执行树任务'
}

export const CASE_LABEL_ZH: Record<string, string> = {
  'G0-001': '构建产物',
  'G0-002': '服务健康检查',
  'G0-003': '独立数据目录',
  'G0-004': '独立端口',
  'G0-005': '单服务约束',
  'G0-006': '用例进程崩溃隔离',
  'G1-003': '初始化登录',
  'G1-007': '鉴权令牌',
  'G1-008': '令牌脱敏',
  'G2-001': '项目与线程',
  'G3-001': '普通对话·单轮',
  'FOUNDATION-FAKE-001': '基础探测',
  'G4-001': '草案·信息不足',
  'G4-002': '草案·分阶段补充',
  'G4-003': '草案·字段完整',
  'G4-012': '草案·确认入规划',
  'DRAFT-MULTITURN-001': '草案·多轮确认',
  'G6-001': '笔记搜索·完整闭环',
  'G6-002': '笔记搜索·假完成陷阱',
  'G8-001': '固定OpenCode链路探测'
}

export const STEP_LABEL_ZH: Record<string, string> = {
  'preflight.start': '预检开始',
  'preflight.keep_runtime': '保留运行目录提示',
  'preflight.database_reset_begin': '开始清空测试数据库',
  'preflight.database_cleared': '测试数据库已清空',
  'preflight.database_clear_retry': '测试数据库二次清理',
  'preflight.database_clear_failed': '测试数据库清理失败',
  'preflight.processes_cleared': '清理残留进程',
  'preflight.opencode_serve_cleared': '清理残留OpenCode',
  'preflight.runtime_cleared': '已重置运行目录',
  'preflight.runtime_clear_failed': '运行目录清理失败',
  'preflight.runtime_clear_retry': '运行目录清理重试',
  'preflight.runtime_absent': '运行目录不存在',
  'run.start': '运行开始',
  'server.ready': '服务就绪',
  'mcp.ready': '测试MCP就绪',
  'case.start': '用例开始',
  'case.done': '用例结束',
  'case.skipped': '用例跳过',
  'auth.ensure': '确保登录',
  'settings.control_plane': '设置控制平面',
  'workspace.copy': '复制工作区',
  'fixture.stage': '装载分阶段语料',
  'worker.start': '启动用例工人',
  'driver.start': '驱动开始',
  'mcp.initialized': 'MCP已初始化',
  'project.created': '已创建项目',
  'thread.created': '已创建线程',
  'collect.snapshot': '收集态快照',
  'turn.done': '一轮对话结束',
  'turn.retry': '对话重试',
  drafts: '草案列表',
  'draft.detail': '草案详情',
  'draft.confirmed': '草案已确认',
  'draft.confirm_final': '草案最终确认',
  'wizard.phase': '向导阶段',
  'job.ready': '规划任务已创建',
  'plan.poll_begin': '开始轮询执行树',
  'plan.poll': '轮询执行树',
  'plan.check': '检查执行树',
  'plan.check_ok': '执行树检查通过',
  'plan.ready': '执行树就绪',
  'plan.inspect': '查看执行树',
  'plan.confirmed': '执行树已确认',
  'plan.continue_attempt': '执行树继续重试',
  'job.wait_begin': '开始等待任务终态',
  'job.wait_error': '等待任务出错(将改轮询)',
  'job.poll_terminal': '轮询任务终态',
  'job.terminal': '任务已结束',
  'case.reported': '用例已交卷'
}

export function slugForCaseId(caseId: string): string {
  return CASE_SLUG_BY_ID[caseId] ?? caseId
}

/** Stdout label: Chinese case name (never print bare G6-001 as scope). */
export function labelForCaseId(caseId: string): string {
  return CASE_LABEL_ZH[caseId] ?? slugForCaseId(caseId)
}

export function labelForPart(part: AcceptancePart): string {
  return PART_LABEL_ZH[part] ?? part
}

export function labelForStep(step: string): string {
  return STEP_LABEL_ZH[step] ?? step
}

export function partForCaseId(caseId: string): AcceptancePart | null {
  if (caseId.startsWith('G3')) return 'conversation'
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
  // Part A depth starter (expand later with more chat matrix)
  conversation: ['G3-001'],
  // Part B depth: Notes Search happy path is the representative chain
  'draft-job': ['G6-001']
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
  all: { parts: ['bootstrap', 'conversation', 'draft-job'] }
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
  for (const piece of raw.split(/[,+\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)) {
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
    throw new Error(
      `unknown_part:${piece}:use conversation|draft-job|bootstrap (or a,b) — not G3/G6`
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
      warnings.push(
        `deprecated_case_id:${input.caseId}:prefer --case ${CASE_SLUG_BY_ID[resolved]}`
      )
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
    '友好用例名（--case <slug>；日志显示中文阶段）：',
    ...Object.entries(CASE_ALIASES).map(([slug, id]) => {
      const zh = CASE_LABEL_ZH[id] ?? id
      return `  ${slug.padEnd(28)} ${zh}`
    }),
    '',
    '阶段（--part）：',
    `  conversation   ${PART_LABEL_ZH.conversation}`,
    `  draft-job      ${PART_LABEL_ZH['draft-job']}`,
    `  bootstrap      ${PART_LABEL_ZH.bootstrap}`,
    '',
    '套件（--suite）：',
    '  smoke | conversation | draft-job | both | all'
  ]
  return lines.join('\n')
}
