export type CaseManifest = {
  caseId: string
  gate: string
  title: string
  driver: 'supervisor' | 'fake' | 'opencode'
  skills: string[]
  allowedTools: string[]
  requiredOperations: string[]
  oracle: {
    requireProject?: boolean
    requireThread?: boolean
    requireAssistantMessage?: boolean
    requireTurnCompleted?: boolean
  }
  fixture?: string
  workspaceFixture?: string
  stagedFixture?: string
  timeoutMs?: number
  skipReason?: string
  /** When set, matching classification counts as passed (e.g. G6-002 oracle_failed). */
  expectClassification?: string
}

export const SMOKE_CASES = [
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
] as const


const DRAFT_MUTATION_TOOLS = [
  'codetask_create_project',
  'codetask_create_thread',
  'case_next_fixture',
  'codetask_start_turn',
  'codetask_wait_turn',
  'codetask_list_messages',
  'codetask_get_thread_drafts',
  'codetask_update_draft',
  'codetask_unlock_draft',
  'codetask_unlock_draft_contract',
  'codetask_confirm_draft_section',
  'codetask_update_ability_providers',
  'codetask_upload_attachment',
  'codetask_confirm_draft',
  'codetask_confirm_draft_final',
  'codetask_soft_request',
  'case_checkpoint',
  'report_case_result'
]

function buildDraftMatrixManifests(): Record<string, CaseManifest> {
  const ids: Array<{ id: string; title: string; skipReason?: string }> = [
    { id: 'G4-004', title: 'Draft update matrix probes' },
    { id: 'G4-005', title: 'Section confirm/lock probes' },
    { id: 'G4-006', title: 'Requirements contract unlock probes' },
    { id: 'G4-007', title: 'Ability provider OpenCode path; Cursor skipped' },
    { id: 'G4-008', title: 'Attachment to draft reference probes' },
    { id: 'G4-009', title: 'Direct reference upload probes' },
    { id: 'G4-010', title: 'Local corpus / forbidden path probes' },
    { id: 'G4-011', title: 'Reference ownership probes' },
    { id: 'G4-013', title: 'Draft delete / cleanup probes' },
    { id: 'G4-014', title: 'REST/MCP draft surface parity probes' }
  ]
  const out: Record<string, CaseManifest> = {}
  for (const item of ids) {
    out[item.id] = {
      caseId: item.id,
      gate: 'G4',
      title: item.title,
      driver: 'fake',
      skills: ['common-blackbox', 'draft-mutations'],
      allowedTools: DRAFT_MUTATION_TOOLS,
      requiredOperations: ['mcp.codetask_create_project', 'case.report_result'],
      oracle: { requireProject: true, requireThread: true },
      workspaceFixture: 'notes-search-project',
      stagedFixture: 'conversation/draft-multiturn.json',
      timeoutMs: 300_000,
      skipReason: item.skipReason
    }
  }
  return out
}

function buildPlannerManifests(): Record<string, CaseManifest> {
  const tools = [
    'codetask_create_project',
    'codetask_create_thread',
    'case_next_fixture',
    'codetask_start_turn',
    'codetask_wait_turn',
    'codetask_list_messages',
    'codetask_get_thread_drafts',
    'codetask_confirm_draft',
    'codetask_confirm_draft_final',
    'codetask_get_latest_job',
    'codetask_get_plans',
    'codetask_confirm_plan',
    'codetask_confirm_plan_node',
    'case_checkpoint',
    'report_case_result'
  ]
  const out: Record<string, CaseManifest> = {}
  for (let i = 1; i <= 10; i++) {
    const id = `G5-${String(i).padStart(3, '0')}`
    out[id] = {
      caseId: id,
      gate: 'G5',
      title: `Planner case ${id}`,
      driver: 'fake',
      skills: ['common-blackbox', 'planner-full'],
      allowedTools: tools,
      requiredOperations: ['mcp.codetask_create_project', 'case.report_result'],
      oracle: { requireProject: true, requireThread: true },
      workspaceFixture: 'notes-search-project',
      stagedFixture: 'conversation/draft-multiturn.json',
      timeoutMs: 300_000,
      skipReason: id === 'G5-010' ? 'provider_disabled:second_provider' : undefined
    }
  }
  return out
}

function buildJobManifests(): Record<string, CaseManifest> {
  const tools = [
    'codetask_create_project',
    'codetask_create_thread',
    'codetask_get_thread',
    'case_next_fixture',
    'codetask_start_turn',
    'codetask_wait_turn',
    'codetask_get_turn',
    'codetask_list_messages',
    'codetask_get_thread_drafts',
    'codetask_confirm_draft',
    'codetask_confirm_draft_final',
    'codetask_get_latest_job',
    'codetask_get_plans',
    'codetask_confirm_plan',
    'codetask_confirm_plan_node',
    'codetask_create_job',
    'codetask_get_job',
    'codetask_wait_job',
    'codetask_get_task_evidence',
    'codetask_pause_job',
    'codetask_resume_job',
    'codetask_continue_job',
    'codetask_cancel_job',
    'codetask_restart_job',
    'codetask_soft_request',
    'case_checkpoint',
    'report_case_result'
  ]
  const out: Record<string, CaseManifest> = {}
  for (let i = 1; i <= 20; i++) {
    const id = `G6-${String(i).padStart(3, '0')}`
    const multi = i >= 16 && i <= 19
    const workspaceFixture =
      i === 5
        ? 'two-task-chain'
        : i === 13
          ? 'recovery-project'
          : i === 14
            ? 'readonly-project'
            : 'notes-search-project'
    out[id] = {
      caseId: id,
      gate: 'G6',
      title: i === 1 ? 'Notes Search happy path' : `Job case ${id}`,
      driver: 'fake',
      skills:
        i === 1
          ? ['common-blackbox', 'draft-multiturn', 'planner-full', 'job-small-task']
          : ['common-blackbox', 'job-small-task', 'job-recovery'],
      allowedTools: tools,
      requiredOperations:
        multi || i === 20
          ? []
          : i === 1
            ? [
                'mcp.codetask_create_project',
                'mcp.codetask_start_turn',
                'mcp.codetask_confirm_draft_final',
                'case.report_result'
              ]
            : ['mcp.codetask_create_project', 'case.report_result'],
      oracle: { requireProject: !multi && i !== 20, requireThread: !multi && i !== 20 },
      workspaceFixture,
      stagedFixture: 'conversation/draft-multiturn.json',
      timeoutMs: i === 1 ? 0 : 300_000,
      skipReason: multi
        ? 'provider_disabled:multi_provider'
        : i === 20
          ? 'generation_branch:v3_not_authoritative'
          : undefined,
      expectClassification: i === 2 ? 'oracle_failed' : undefined
    }
  }
  return out
}

function buildRecoveryAndFullManifests(): Record<string, CaseManifest> {
  const baseTools = [
    'codetask_create_project',
    'codetask_create_thread',
    'codetask_soft_request',
    'case_checkpoint',
    'report_case_result'
  ]
  const out: Record<string, CaseManifest> = {}
  for (const id of [
    'G7-001',
    'G7-002',
    'G7-003',
    'G7-004',
    'G7-005',
    'G7-006',
    'G7-007',
    'G7-008',
    'G7-009'
  ]) {
    out[id] = {
      caseId: id,
      gate: 'G7',
      title: `Recovery/realtime case ${id}`,
      driver: 'fake',
      skills: ['common-blackbox'],
      allowedTools: baseTools,
      requiredOperations: id === 'G7-009' ? [] : ['case.report_result'],
      oracle: {},
      workspaceFixture: 'empty-project',
      timeoutMs: 120_000,
      skipReason: id === 'G7-009' ? 'provider_disabled:cursor_concurrency' : undefined
    }
  }
  out['G8-001'] = {
    caseId: 'G8-001',
    gate: 'G8',
    title: 'fixed-opencode full end-to-end chain (scripted fake MCP path)',
    driver: 'fake',
    skills: ['common-blackbox', 'draft-multiturn', 'planner-full', 'job-small-task'],
    allowedTools: [
      ...DRAFT_MUTATION_TOOLS,
      'codetask_get_latest_job',
      'codetask_get_plans',
      'codetask_confirm_plan',
      'codetask_create_job',
      'codetask_get_job',
      'codetask_wait_job',
      'codetask_get_task_evidence'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'case.report_result'
    ],
    oracle: { requireProject: true, requireThread: true },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json',
    timeoutMs: 600_000
  }
  return out
}

export const MANIFESTS: Record<string, CaseManifest> = {
  'G0-001': {
    caseId: 'G0-001',
    gate: 'G0',
    title: 'standalone build artifact exists',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'G0-002': {
    caseId: 'G0-002',
    gate: 'G0',
    title: 'headless startup health',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: ['health.get'],
    oracle: {}
  },
  'G0-003': {
    caseId: 'G0-003',
    gate: 'G0',
    title: 'independent data and bootstrap dirs',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'G0-004': {
    caseId: 'G0-004',
    gate: 'G0',
    title: 'independent localhost port',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'G0-005': {
    caseId: 'G0-005',
    gate: 'G0',
    title: 'single dedicated server',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'G0-006': {
    caseId: 'G0-006',
    gate: 'G0',
    title: 'case worker crash does not kill server',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'G1-003': {
    caseId: 'G1-003',
    gate: 'G1',
    title: 'correct setup',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: ['auth.setup', 'auth.login'],
    oracle: {}
  },
  'G1-007': {
    caseId: 'G1-007',
    gate: 'G1',
    title: 'missing or invalid bearer rejected',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'G1-008': {
    caseId: 'G1-008',
    gate: 'G1',
    title: 'token redaction in reports',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'G2-001': {
    caseId: 'G2-001',
    gate: 'G2',
    title: 'project and thread CRUD via Test MCP',
    driver: 'fake',
    skills: ['common-blackbox', 'project-thread'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'codetask_list_cores',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'mcp.codetask_get_thread',
      'case.report_result'
    ],
    oracle: {
      requireProject: true,
      requireThread: true
    }
  },
  'G3-001': {
    caseId: 'G3-001',
    gate: 'G3',
    title: 'single-turn Chinese conversation via OpenCode driver',
    driver: 'opencode',
    skills: ['common-blackbox', 'project-thread', 'conversation-basic'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'codetask_list_cores',
      'codetask_start_turn',
      'codetask_get_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'mcp.codetask_start_turn',
      'case.report_result'
    ],
    oracle: {
      requireProject: true,
      requireThread: true,
      requireAssistantMessage: true,
      requireTurnCompleted: true
    },
    fixture: 'conversation/basic-zh.json'
  },
  'CHAT-HTML-001': {
    caseId: 'CHAT-HTML-001',
    gate: 'G3',
    title: 'conversation creates SDK-named HTML file then Node oracle checks',
    driver: 'fake',
    skills: ['common-blackbox', 'project-thread', 'conversation-create-html'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'codetask_list_cores',
      'codetask_start_turn',
      'codetask_get_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'mcp.codetask_start_turn',
      'case.report_result'
    ],
    oracle: {
      requireProject: true,
      requireThread: true,
      requireAssistantMessage: true,
      requireTurnCompleted: true
    },
    fixture: 'conversation/create-html.json',
    workspaceFixture: 'empty-project',
    // Wait until turn/API terminal; no worker kill timer.
    timeoutMs: 0
  },
  'JOB-CHAT-RO-001': {
    caseId: 'JOB-CHAT-RO-001',
    gate: 'G6',
    title:
      'phase-2 thicken: task1 running + task2 + chat reads job dir as readonly',
    driver: 'fake',
    skills: ['common-blackbox', 'project-thread', 'job-chat-readonly'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'codetask_start_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_get_latest_job',
      'codetask_get_job',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'case.report_result'
    ],
    oracle: { requireProject: true, requireThread: true },
    workspaceFixture: 'empty-project',
    timeoutMs: 300_000
  },
  'SETTINGS-MCP-001': {
    caseId: 'SETTINGS-MCP-001',
    gate: 'G2',
    title:
      'phase-3: register business-e2e-probe into conversation/task/verification MCP settings',
    driver: 'fake',
    skills: ['common-blackbox', 'settings-mcp-probe'],
    allowedTools: [
      'codetask_get_mcp_settings',
      'codetask_put_mcp_settings',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_get_mcp_settings',
      'mcp.codetask_put_mcp_settings',
      'case.report_result'
    ],
    oracle: {},
    timeoutMs: 120_000
  },
  'FOUNDATION-FAKE-001': {
    caseId: 'FOUNDATION-FAKE-001',
    gate: 'foundation',
    title: 'Fake Driver exercises create_task + staged fixture + draft/plan/job MCP surface',
    driver: 'fake',
    skills: [],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'case_next_fixture',
      'codetask_get_thread_drafts',
      'codetask_confirm_draft',
      'codetask_confirm_draft_final',
      'codetask_get_latest_job',
      'codetask_get_plans',
      'codetask_confirm_plan',
      'codetask_create_job',
      'codetask_get_job',
      'codetask_wait_job',
      'codetask_get_task_evidence',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'mcp.case_next_fixture',
      'mcp.codetask_get_thread_drafts',
      'case.report_result'
    ],
    oracle: {
      requireProject: true,
      requireThread: true
    },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json'
  },
  'G4-001': {
    caseId: 'G4-001',
    gate: 'G4',
    title: 'fuzzy request does not produce a full draft yet',
    driver: 'fake',
    skills: ['common-blackbox', 'draft-multiturn'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'case_next_fixture',
      'codetask_start_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_get_thread_drafts',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'mcp.case_next_fixture',
      'mcp.codetask_start_turn',
      'case.report_result'
    ],
    oracle: { requireProject: true, requireThread: true },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json',
    timeoutMs: 300_000
  },
  'G4-002': {
    caseId: 'G4-002',
    gate: 'G4',
    title: 'staged fixture unlock across draft collection turns',
    driver: 'fake',
    skills: ['common-blackbox', 'draft-multiturn'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'case_next_fixture',
      'codetask_start_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_get_thread_drafts',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.case_next_fixture',
      'mcp.codetask_start_turn',
      'case.report_result'
    ],
    oracle: { requireProject: true, requireThread: true },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json',
    timeoutMs: 600_000
  },
  'G4-003': {
    caseId: 'G4-003',
    gate: 'G4',
    title: 'draft fields cover public invariants',
    driver: 'fake',
    skills: ['common-blackbox', 'draft-multiturn'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'case_next_fixture',
      'codetask_start_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_get_thread_drafts',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: ['mcp.codetask_get_thread_drafts', 'case.report_result'],
    oracle: { requireProject: true, requireThread: true },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json',
    timeoutMs: 600_000
  },
  'G4-012': {
    caseId: 'G4-012',
    gate: 'G4',
    title: 'draft confirm and confirm-final enter planning',
    driver: 'fake',
    skills: ['common-blackbox', 'draft-multiturn'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'case_next_fixture',
      'codetask_start_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_get_thread_drafts',
      'codetask_confirm_draft',
      'codetask_confirm_draft_final',
      'codetask_get_latest_job',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_start_turn',
      'mcp.codetask_get_thread_drafts',
      'case.report_result'
    ],
    oracle: { requireProject: true, requireThread: true },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json',
    timeoutMs: 600_000
  },
  'DRAFT-MULTITURN-001': {
    caseId: 'DRAFT-MULTITURN-001',
    gate: 'G4',
    title: 'alias for draft multiturn core chain (G4-002 + confirm path)',
    driver: 'fake',
    skills: ['common-blackbox', 'draft-multiturn'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'case_next_fixture',
      'codetask_start_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_get_thread_drafts',
      'codetask_confirm_draft',
      'codetask_confirm_draft_final',
      'codetask_get_latest_job',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.case_next_fixture',
      'mcp.codetask_start_turn',
      'case.report_result'
    ],
    oracle: { requireProject: true, requireThread: true },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json',
    timeoutMs: 600_000
  },
  ...buildDraftMatrixManifests(),
  ...buildPlannerManifests(),
  ...buildJobManifests(),
  ...buildRecoveryAndFullManifests()
}


export const DRAFT_CORE_CASES = ['G4-001', 'G4-002', 'G4-003', 'G4-012'] as const

export function resolveCaseIds(options: {
  gate?: string
  caseId?: string
}): string[] {
  if (options.caseId) return [options.caseId]
  if (options.gate === 'smoke') return [...SMOKE_CASES]
  if (options.gate === 'foundation') return ['FOUNDATION-FAKE-001']
  if (options.gate === 'draft-core') return [...DRAFT_CORE_CASES]
  if (options.gate === 'conversation' || options.gate === 'chat') return ['G3-001', 'CHAT-HTML-001']
  if (options.gate === 'draft-job' || options.gate === 'draft' || options.gate === 'job') {
    return ['G6-001', 'JOB-CHAT-RO-001']
  }
  if (options.gate === 'settings-mcp' || options.gate === 'mcp') return ['SETTINGS-MCP-001']
  if (options.gate === 'both' || options.gate === 'a-b') {
    return ['G3-001', 'CHAT-HTML-001', 'G6-001', 'JOB-CHAT-RO-001']
  }
  if (options.gate === 'phases') {
    return ['G3-001', 'CHAT-HTML-001', 'G6-001', 'JOB-CHAT-RO-001', 'SETTINGS-MCP-001']
  }
  if (options.gate === 'fixed-opencode-full') {
    return [
      ...SMOKE_CASES,
      'FOUNDATION-FAKE-001',
      ...Object.values(MANIFESTS)
        .filter((item) => ['G4', 'G5', 'G6', 'G7', 'G8'].includes(item.gate))
        .map((item) => item.caseId)
    ]
  }
  if (options.gate) {
    return Object.values(MANIFESTS)
      .filter((item) => item.gate === options.gate)
      .map((item) => item.caseId)
  }
  return [...SMOKE_CASES]
}
