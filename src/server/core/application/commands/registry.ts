import { confirmDraftCommand } from './confirm-draft'
import { patchDraftCommand } from './patch-draft'
import { confirmDraftSectionCommand } from './confirm-draft-section'
import { unlockDraftCommand } from './unlock-draft'
import { confirmDraftFinalCommand } from './confirm-draft-final'
import { createPlanCommand } from './create-plan'
import { confirmPlanCommand } from './confirm-plan'
import { enqueueJobCommand } from './enqueue-job'
import { pauseJobCommand } from './pause-job'
import { continueJobCommand } from './continue-job'
import { cancelJobCommand } from './cancel-job'
import { retryJobCommand } from './retry-job'

/**
 * Named command registry for composition / tests (Wave 3).
 */
export const commandRegistry = {
  confirmDraft: confirmDraftCommand,
  patchDraft: patchDraftCommand,
  confirmDraftSection: confirmDraftSectionCommand,
  unlockDraft: unlockDraftCommand,
  confirmDraftFinal: confirmDraftFinalCommand,
  createPlan: createPlanCommand,
  confirmPlan: confirmPlanCommand,
  enqueueJob: enqueueJobCommand,
  pauseJob: pauseJobCommand,
  continueJob: continueJobCommand,
  cancelJob: cancelJobCommand,
  retryJob: retryJobCommand
} as const

export type CommandName = keyof typeof commandRegistry
