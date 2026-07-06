import type { WizardPhase } from './types'
import {
  WIZARD_PHASE_COLLECT,
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT,
  WIZARD_PHASE_PLAN_GENERATING,
  WIZARD_PHASE_READY_TO_LAUNCH
} from './types'

const COMMON_TOOLS = ['read_reference_attachment', 'rename_thread'] as const

const PHASE_TOOL_NAMES: Record<WizardPhase, readonly string[]> = {
  [WIZARD_PHASE_COLLECT]: [...COMMON_TOOLS, 'propose_task_draft', 'delete_thread'],
  [WIZARD_PHASE_DRAFT_REVIEW]: [
    ...COMMON_TOOLS,
    'get_task_draft',
    'revise_requirements_contract',
    'update_task_draft',
    'confirm_requirements_contract',
    'confirm_draft_section',
    'list_reference_corpus',
    'update_reference_corpus_item',
    'remove_reference_corpus_item',
    'request_phase_rollback'
  ],
  [WIZARD_PHASE_PLAN_GENERATING]: [
    ...COMMON_TOOLS,
    'get_task_draft',
    'list_reference_corpus',
    'request_phase_rollback'
  ],
  [WIZARD_PHASE_PLAN_EDIT]: [
    ...COMMON_TOOLS,
    'get_task_draft',
    'get_execution_plan',
    'update_execution_plan_node',
    'replace_execution_plan',
    'request_plan_regeneration',
    'request_phase_rollback'
  ],
  [WIZARD_PHASE_READY_TO_LAUNCH]: [
    ...COMMON_TOOLS,
    'get_task_draft',
    'get_execution_plan',
    'request_phase_rollback'
  ]
}

export function toolsForWizardPhase(phase: WizardPhase): readonly string[] {
  return PHASE_TOOL_NAMES[phase]
}

export function allCreateTaskMcpToolNames(): readonly string[] {
  const names = new Set<string>()
  for (const tools of Object.values(PHASE_TOOL_NAMES)) {
    for (const tool of tools) {
      names.add(tool)
    }
  }
  return [...names]
}

export function isToolAllowedInWizardPhase(toolName: string, phase: WizardPhase): boolean {
  return PHASE_TOOL_NAMES[phase].includes(toolName)
}
