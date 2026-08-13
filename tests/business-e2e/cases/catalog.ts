export type CaseGate = 'bootstrap' | 'conversation' | 'design' | 'settings-mcp'

export type CaseManifest = {
  caseId: string
  gate: CaseGate
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
  /** When set, a matching negative-test classification counts as passed. */
  expectClassification?: string
}

export const SMOKE_CASES = [
  'build-artifact',
  'server-health',
  'isolated-dirs',
  'isolated-port',
  'single-server',
  'setup-login',
  'auth-bearer',
  'token-redaction',
  'worker-crash',
  'project-conversation',
  'chat-basic'
] as const

export const MANIFESTS: Record<string, CaseManifest> = {
  'build-artifact': {
    caseId: 'build-artifact',
    gate: 'bootstrap',
    title: 'standalone build artifact exists',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'server-health': {
    caseId: 'server-health',
    gate: 'bootstrap',
    title: 'headless startup health',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: ['health.get'],
    oracle: {}
  },
  'isolated-dirs': {
    caseId: 'isolated-dirs',
    gate: 'bootstrap',
    title: 'independent data and bootstrap dirs',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'isolated-port': {
    caseId: 'isolated-port',
    gate: 'bootstrap',
    title: 'independent localhost port',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'single-server': {
    caseId: 'single-server',
    gate: 'bootstrap',
    title: 'single dedicated server',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'worker-crash': {
    caseId: 'worker-crash',
    gate: 'bootstrap',
    title: 'case worker crash does not kill server',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'setup-login': {
    caseId: 'setup-login',
    gate: 'bootstrap',
    title: 'correct setup',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: ['auth.setup', 'auth.login'],
    oracle: {}
  },
  'auth-bearer': {
    caseId: 'auth-bearer',
    gate: 'bootstrap',
    title: 'missing or invalid bearer rejected',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'token-redaction': {
    caseId: 'token-redaction',
    gate: 'bootstrap',
    title: 'token redaction in reports',
    driver: 'supervisor',
    skills: [],
    allowedTools: [],
    requiredOperations: [],
    oracle: {}
  },
  'project-conversation': {
    caseId: 'project-conversation',
    gate: 'bootstrap',
    title: 'project and conversation CRUD via Test MCP',
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
  'chat-basic': {
    caseId: 'chat-basic',
    gate: 'conversation',
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
  'chat-create-html': {
    caseId: 'chat-create-html',
    gate: 'conversation',
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
  'chat-image-attachment': {
    caseId: 'chat-image-attachment',
    gate: 'conversation',
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
  'settings-mcp-probe': {
    caseId: 'settings-mcp-probe',
    gate: 'settings-mcp',
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
  'foundation-probe': {
    caseId: 'foundation-probe',
    gate: 'design',
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
  'design-draft-confirm': {
    caseId: 'design-draft-confirm',
    gate: 'design',
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
  if (options.gate === 'foundation') return ['foundation-probe']
  if (options.gate === 'draft-core' || options.gate === 'design' || options.gate === 'draft') {
    return ['design-draft-confirm']
  }
  if (options.gate === 'conversation' || options.gate === 'chat') {
    return ['chat-basic', 'chat-create-html', 'chat-image-attachment']
  }
  if (options.gate === 'settings-mcp' || options.gate === 'mcp') return ['settings-mcp-probe']
  if (options.gate === 'both' || options.gate === 'a-b') {
    return ['chat-basic', 'chat-create-html', 'chat-image-attachment', 'design-draft-confirm']
  }
  if (options.gate === 'phases') {
    return [
      'chat-basic',
      'chat-create-html',
      'chat-image-attachment',
      'design-draft-confirm',
      'settings-mcp-probe'
    ]
  }
  if (options.gate === 'all') {
    return [
      'build-artifact',
      'server-health',
      'isolated-dirs',
      'isolated-port',
      'single-server',
      'setup-login',
      'auth-bearer',
      'token-redaction',
      'worker-crash',
      'project-conversation',
      'foundation-probe',
      'chat-basic',
      'chat-create-html',
      'chat-image-attachment',
      'design-draft-confirm',
      'settings-mcp-probe'
    ]
  }
  if (options.gate === 'fixed-opencode-full') {
    return [...SMOKE_CASES, 'foundation-probe', 'design-draft-confirm']
  }
  if (options.gate) {
    return Object.values(MANIFESTS)
      .filter((item) => item.gate === options.gate)
      .map((item) => item.caseId)
  }
  return [...SMOKE_CASES]
}
