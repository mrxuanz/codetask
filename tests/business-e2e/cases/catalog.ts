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
  /**
   * Optional overall worker budget.
   * Omit or <=0 → unbounded case wait for CodeTask business API terminal;
   * OpenCode startup/prompt/report stages stay finite.
   * Positive values shrink stage budgets to fit.
   * `--no-timeout` unlocks OpenCode stage ceilings (forbidden in CI).
   */
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
    workspaceFixture: 'empty-project'
  },
  'CHAT-IMG-001': {
    caseId: 'CHAT-IMG-001',
    gate: 'G3',
    title: 'chat can read uploaded image attachment via selected core',
    driver: 'fake',
    skills: ['common-blackbox', 'project-thread', 'chat-image-attachment'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'codetask_list_cores',
      'codetask_upload_attachment',
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
      'mcp.codetask_upload_attachment',
      'mcp.codetask_start_turn',
      'case.report_result'
    ],
    oracle: {
      requireProject: true,
      requireThread: true,
      requireAssistantMessage: true,
      requireTurnCompleted: true
    },
    fixture: 'conversation/chat-image-attachment.json',
    workspaceFixture: 'empty-project'
  },
  'SETTINGS-MCP-001': {
    caseId: 'SETTINGS-MCP-001',
    gate: 'G2',
    title: 'phase-3: register business-e2e-probe into conversation/task/verification MCP settings',
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
    oracle: {}
  },
  'FOUNDATION-FAKE-001': {
    caseId: 'FOUNDATION-FAKE-001',
    gate: 'foundation',
    title: 'Fake Driver exercises chat clarify-loop + Design draft MCP surface (architecture 03)',
    driver: 'fake',
    skills: ['common-blackbox', 'project-thread', 'draft-multiturn'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_get_thread',
      'case_next_fixture',
      'codetask_start_turn',
      'codetask_get_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_create_draft',
      'codetask_list_drafts',
      'codetask_get_draft',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'mcp.case_next_fixture',
      'mcp.codetask_start_turn',
      'mcp.codetask_create_draft',
      'mcp.codetask_list_drafts',
      'case.report_result'
    ],
    oracle: {
      requireProject: true,
      requireThread: true
    },
    workspaceFixture: 'notes-search-project',
    stagedFixture: 'conversation/draft-multiturn.json'
  },
  'DESIGN-DRAFT-001': {
    caseId: 'DESIGN-DRAFT-001',
    gate: 'draft-job',
    title:
      'Chat clarify-loop then Design draft create → abilities → execution profile → confirm (/api/drafts)',
    driver: 'fake',
    skills: ['common-blackbox', 'project-thread', 'draft-multiturn'],
    allowedTools: [
      'codetask_create_project',
      'codetask_create_thread',
      'codetask_start_turn',
      'codetask_get_turn',
      'codetask_wait_turn',
      'codetask_list_messages',
      'codetask_create_draft',
      'codetask_list_drafts',
      'codetask_get_draft',
      'codetask_patch_draft_abilities',
      'codetask_patch_draft_execution_profile',
      'codetask_confirm_design_draft',
      'case_checkpoint',
      'report_case_result'
    ],
    requiredOperations: [
      'mcp.codetask_create_project',
      'mcp.codetask_create_thread',
      'mcp.codetask_start_turn',
      'mcp.codetask_create_draft',
      'mcp.codetask_patch_draft_abilities',
      'mcp.codetask_patch_draft_execution_profile',
      'mcp.codetask_confirm_design_draft',
      'case.report_result'
    ],
    oracle: {
      requireProject: true,
      requireThread: true
    },
    workspaceFixture: 'notes-search-project'
  }
}

export function resolveCaseIds(options: { gate?: string; caseId?: string }): string[] {
  if (options.caseId) return [options.caseId]
  if (options.gate === 'smoke') return [...SMOKE_CASES]
  if (options.gate === 'foundation') return ['FOUNDATION-FAKE-001']
  if (
    options.gate === 'draft-core' ||
    options.gate === 'draft-job' ||
    options.gate === 'draft' ||
    options.gate === 'job'
  ) {
    return ['DESIGN-DRAFT-001']
  }
  if (options.gate === 'conversation' || options.gate === 'chat') {
    return ['G3-001', 'CHAT-HTML-001', 'CHAT-IMG-001']
  }
  if (options.gate === 'settings-mcp' || options.gate === 'mcp') return ['SETTINGS-MCP-001']
  if (options.gate === 'both' || options.gate === 'a-b') {
    return ['G3-001', 'CHAT-HTML-001', 'CHAT-IMG-001', 'DESIGN-DRAFT-001']
  }
  if (options.gate === 'phases') {
    return ['G3-001', 'CHAT-HTML-001', 'CHAT-IMG-001', 'DESIGN-DRAFT-001', 'SETTINGS-MCP-001']
  }
  if (options.gate === 'fixed-opencode-full') {
    return [...SMOKE_CASES, 'FOUNDATION-FAKE-001', 'DESIGN-DRAFT-001']
  }
  if (options.gate) {
    return Object.values(MANIFESTS)
      .filter((item) => item.gate === options.gate)
      .map((item) => item.caseId)
  }
  return [...SMOKE_CASES]
}
