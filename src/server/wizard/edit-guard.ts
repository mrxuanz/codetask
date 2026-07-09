import { AppError } from '../error'
import type { TaskLaunchDraftPayload } from '../conversation/draft/types'
import { isDraftEditable } from '../conversation/draft/status'
import { getThreadRow } from '../threads/service'
import type { Thread } from '../db/schema'
import { getThreadJob } from '../jobs/service'
import { resolveWizardPhase } from './phase'
import {
  WIZARD_PHASE_COLLECT,
  WIZARD_PHASE_DRAFT_REVIEW,
  WIZARD_PHASE_PLAN_EDIT,
  WIZARD_PHASE_PLAN_GENERATING,
  WIZARD_PHASE_READY_TO_LAUNCH,
  isWizardPhase,
  type WizardPhase
} from './types'
import { isToolAllowedInWizardPhase } from './tools'

export function isDraftWorkspaceLocked(
  payload: Pick<TaskLaunchDraftPayload, 'status' | 'linkedPlanId'>,
  threadRow: Pick<Thread, 'activePlanId'>
): boolean {
  if (!isDraftEditable(payload)) return true
  if (payload.linkedPlanId?.trim()) return true
  if (threadRow.activePlanId?.trim()) return true
  return false
}

export interface DraftEditGuardResult {
  allowed: boolean
  message: string
  unlockRequired?: boolean
  reason?: 'locked' | 'wrong_phase' | 'not_editable'
}

export async function checkDraftEditAllowed(input: {
  username: string
  threadId: string
  draftMessageId: string
  payload?: TaskLaunchDraftPayload
}): Promise<DraftEditGuardResult> {
  const row = await getThreadRow(input.username, input.threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')

  const phase = resolveWizardPhase(row)
  if (phase !== WIZARD_PHASE_DRAFT_REVIEW) {
    return {
      allowed: false,
      reason: 'wrong_phase',
      unlockRequired: Boolean(row.activePlanId || input.payload?.linkedPlanId),
      message:
        phase === WIZARD_PHASE_PLAN_GENERATING ||
        phase === WIZARD_PHASE_PLAN_EDIT ||
        phase === WIZARD_PHASE_READY_TO_LAUNCH
          ? 'Draft is locked because an execution plan exists or is being generated. Unlock the draft in the Web UI to clear the plan before editing.'
          : `Current phase is ${phase}; draft cannot be modified.`
    }
  }

  const payload =
    input.payload ??
    (await (async () => {
      const { getMessage } = await import('../conversation/messages')
      const message = await getMessage(input.username, input.threadId, input.draftMessageId, {
        signAssets: false
      })
      return message?.payload as TaskLaunchDraftPayload | undefined
    })())

  if (!payload?.draftId) {
    return {
      allowed: false,
      reason: 'not_editable',
      message: 'Task draft does not exist or payload is invalid'
    }
  }

  if (isDraftWorkspaceLocked(payload, row)) {
    return {
      allowed: false,
      reason: 'locked',
      unlockRequired: true,
      message:
        'Draft is locked because it is confirmed and linked to an execution plan. Unlock the draft in the Web UI and confirm the warning before editing.'
    }
  }

  if (!isDraftEditable(payload)) {
    return {
      allowed: false,
      reason: 'not_editable',
      unlockRequired: true,
      message: 'Draft is confirmed and cannot be modified. Unlock it in the Web UI before editing.'
    }
  }

  return { allowed: true, message: '' }
}

export interface ExecutionPlanEditGuardResult {
  allowed: boolean
  message: string
  reason?: 'no_plan' | 'plan_generating' | 'wrong_phase' | 'wrong_status' | 'no_plan_tree'
}

export async function checkExecutionPlanEditAllowed(input: {
  username: string
  threadId: string
  planOrSessionId?: string | null
}): Promise<ExecutionPlanEditGuardResult> {
  const row = await getThreadRow(input.username, input.threadId)
  if (!row) throw AppError.notFound('Thread not found', 'thread.not_found')

  const phase = resolveWizardPhase(row)
  const planId = input.planOrSessionId?.trim() || row.activePlanId?.trim() || ''

  if (phase === WIZARD_PHASE_COLLECT || phase === WIZARD_PHASE_DRAFT_REVIEW) {
    return {
      allowed: false,
      reason: 'no_plan',
      message:
        'Execution tree has not been generated yet. Please confirm the draft and generate the execution tree in the Web UI, or wait for planning to complete before editing.'
    }
  }

  if (!planId) {
    return {
      allowed: false,
      reason: 'no_plan',
      message:
        'There is no execution tree to modify. Please confirm the draft and generate the execution tree in the Web UI first.'
    }
  }

  const job = await getThreadJob(input.username, input.threadId, planId)
  if (!job) {
    return {
      allowed: false,
      reason: 'no_plan',
      message: 'Execution tree does not exist or is not accessible.'
    }
  }

  if (job.status === 'planning' || phase === WIZARD_PHASE_PLAN_GENERATING) {
    const hasTree = Boolean(job.plan?.milestones?.length)
    if (!hasTree) {
      return {
        allowed: false,
        reason: 'plan_generating',
        message:
          'Execution tree is still being generated and is not ready yet. Please call get_execution_plan later to check progress, and edit after generation completes.'
      }
    }
  }

  if (phase === WIZARD_PHASE_READY_TO_LAUNCH) {
    return {
      allowed: false,
      reason: 'wrong_phase',
      message:
        'Execution tree has entered the ready-to-launch phase. Unlock the draft in the Web UI before modifying or regenerating the tree.'
    }
  }

  if (phase !== WIZARD_PHASE_PLAN_EDIT) {
    return {
      allowed: false,
      reason: 'wrong_phase',
      message: `Current phase is ${phase}; execution tree cannot be modified.`
    }
  }

  if (job.status === 'cancelled' || job.status === 'failed') {
    return {
      allowed: false,
      reason: 'wrong_status',
      message: `Execution tree status is ${job.status}. Unlock the draft in the Web UI and regenerate.`
    }
  }

  if (job.status !== 'plan_editing') {
    return {
      allowed: false,
      reason: 'wrong_status',
      message: `Execution tree status is ${job.status}; only plan_editing status allows modifications.`
    }
  }

  if (!job.plan?.milestones?.length) {
    return {
      allowed: false,
      reason: 'no_plan_tree',
      message:
        'Execution tree has not finished generating. Please wait for planning to complete before editing, or call get_execution_plan to check status.'
    }
  }

  return { allowed: true, message: '' }
}

export function evaluateWizardToolPhaseAccess(input: {
  toolName: string
  wizardStage: WizardPhase | string | null | undefined
  resolvedPhase: WizardPhase
}): { allowed: boolean; message: string } | null {
  const stage = isWizardPhase(input.wizardStage) ? input.wizardStage : input.resolvedPhase
  if (isToolAllowedInWizardPhase(input.toolName, stage)) {
    return null
  }

  const draftMutationTools = new Set([
    'update_task_draft',
    'revise_requirements_contract',
    'confirm_draft_section',
    'confirm_requirements_contract'
  ])
  const planMutationTools = new Set([
    'update_execution_plan_node',
    'replace_execution_plan',
    'request_plan_regeneration'
  ])

  if (draftMutationTools.has(input.toolName)) {
    return {
      allowed: false,
      message:
        input.resolvedPhase === WIZARD_PHASE_PLAN_EDIT ||
        input.resolvedPhase === WIZARD_PHASE_PLAN_GENERATING ||
        input.resolvedPhase === WIZARD_PHASE_READY_TO_LAUNCH
          ? 'Draft editing tools are unavailable in the current phase because an execution plan exists or is being generated. Unlock the draft in the Web UI before editing.'
          : `Tool "${input.toolName}" is not available in the current phase (${input.resolvedPhase}).`
    }
  }

  if (planMutationTools.has(input.toolName)) {
    return {
      allowed: false,
      message:
        input.resolvedPhase === WIZARD_PHASE_DRAFT_REVIEW ||
        input.resolvedPhase === WIZARD_PHASE_COLLECT
          ? 'Execution tree editing tools are unavailable because the execution tree has not been generated. Please confirm the draft and generate the execution tree first.'
          : `Tool "${input.toolName}" is not available in the current phase (${input.resolvedPhase}).`
    }
  }

  return {
    allowed: false,
    message: `Tool "${input.toolName}" is not available in the current phase (${input.resolvedPhase}).`
  }
}

export function mcpMutationRejected(
  message: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    accepted: false,
    ok: false,
    message,
    ...extra
  }
}
