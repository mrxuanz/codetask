import type { WizardPhase } from './types'
import { WIZARD_PHASE_COLLECT, WIZARD_PHASE_DRAFT_REVIEW, WIZARD_PHASE_PLAN_EDIT } from './types'

export function buildWizardPhasePromptSection(phase: WizardPhase): string {
  switch (phase) {
    case WIZARD_PHASE_COLLECT:
      return [
        '## Create-task wizard (requirements collection)',
        'There is no task draft yet. Clarify scope, architecture, error handling, and quality in conversation.',
        'On the first turn, a workspace snapshot of the bound project folder is attached — ground your reply in what already exists there.',
        'When the four layers are sufficiently complete, call `propose_task_draft` once.',
        'Do not call draft or execution-plan tools — they are not available in this phase.'
      ].join('\n')
    case WIZARD_PHASE_DRAFT_REVIEW:
      return [
        '## Create-task wizard (draft review)',
        'A task launch draft exists. For contract edits use this chain:',
        '1) `get_task_draft` — read revision + REQUIREMENTS CONTRACT markdown from server.',
        '2) `revise_requirements_contract` — preferred atomic read-modify-write (pass revision + replacements or full markdown).',
        '   Or `update_task_draft` with the same revision for structured field edits.',
        'Do not claim contract changes without calling one of these tools.',
        'Confirm REQUIREMENTS CONTRACT with `confirm_requirements_contract` when the user explicitly agrees.',
        'If requirements need a full rethink, call `request_phase_rollback` to return to collection — do not silently rewrite scope.',
        'Execution-plan tools are not available until the draft is confirmed and planning starts.'
      ].join('\n')
    case WIZARD_PHASE_PLAN_EDIT:
      return [
        '## Create-task wizard (execution tree)',
        'The draft is confirmed and a DesignSession execution plan exists (no Job until Launch). For execution tree edits use this chain:',
        '1) `get_task_draft` — read REQUIREMENTS CONTRACT, abilities, references, and acceptance from the linked draft.',
        '2) `get_execution_plan` — read planRevision, milestone/slice/task tree, confirmed flags, and task contextMarkdown.',
        '3) Small edits: `update_execution_plan_node` with designSessionId, nodeRef (m4, m4-s1, m4-s1-t1), and expectedPlanRevision from get_execution_plan.',
        '4) Full tree replace: `replace_execution_plan` with expectedPlanRevision + milestones.',
        '5) Complex reorder: `request_plan_regeneration` with expectedPlanRevision + instruction.',
        'Reference corpus edits require re-freeze in the UI before Launch; plan confirmations reset after corpus changes.',
        'replace_execution_plan and request_plan_regeneration clear all confirmed flags.',
        'Do not claim plan changes without calling one of these tools.',
        'Do not modify the draft or reopen requirements unless the user requests rollback via `request_phase_rollback`.'
      ].join('\n')
    default:
      return ''
  }
}

export function buildWizardContextSnapshot(input: {
  wizardPhase: WizardPhase
  activeDraftId: string | null
  activePlanId: string | null
  draftRevision?: number | null
  planRevision?: number | null
  designSessionId?: string | null
  selectedDraftSection?: string | null
  selectedPlanNodeRef?: string | null
}): string {
  const designSessionId =
    input.designSessionId ?? (input.activePlanId?.startsWith('ds-') ? input.activePlanId : null)

  const lines = [
    '## Create-task context (authoritative)',
    `wizard_phase: ${input.wizardPhase}`,
    `thread_id: (bound server-side)`,
    `design_session_id: ${designSessionId ?? 'null'}`,
    `active_draft_id: ${input.activeDraftId ?? 'null'}`,
    `active_plan_id: ${input.activePlanId ?? 'null'}`
  ]
  if (input.draftRevision != null) {
    lines.push(`draft_revision: ${input.draftRevision}`)
  }
  if (input.planRevision != null) {
    lines.push(`plan_revision: ${input.planRevision}`)
  }
  if (input.selectedDraftSection) {
    lines.push(`selected_draft_section: ${input.selectedDraftSection}`)
  }
  if (input.selectedPlanNodeRef) {
    lines.push(`selected_plan_node_ref: ${input.selectedPlanNodeRef}`)
  }

  const contextJson: Record<string, unknown> = { createTaskMode: true }
  if (input.selectedDraftSection) {
    contextJson.selectedDraftSection = input.selectedDraftSection
  }
  if (input.selectedPlanNodeRef) {
    contextJson.selectedPlanNodeRef = input.selectedPlanNodeRef
  }
  lines.push('', '```json', JSON.stringify(contextJson, null, 2), '```')
  return lines.join('\n')
}
