import type { TaskEvidence } from '@codetask/contracts'
import { ExecutionValidationError } from '../../shared.ts'

export function validateTaskEvidence(evidence: TaskEvidence): void {
  if (!evidence.summary?.trim()) {
    throw new ExecutionValidationError('Evidence summary required')
  }
  if (evidence.status === 'completed' && evidence.blockers?.length) {
    throw new ExecutionValidationError('Completed evidence cannot have blockers')
  }
  if (evidence.status === 'blocked' && !evidence.blockers?.length) {
    throw new ExecutionValidationError('Blocked evidence requires blockers')
  }
  for (const file of evidence.changedFiles) {
    if (file.startsWith('/') || file.includes('..')) {
      throw new ExecutionValidationError(`Invalid changed file path: ${file}`)
    }
  }
}

export function defaultCompletedEvidence(summary: string): TaskEvidence {
  return {
    status: 'completed',
    summary,
    changedFiles: [],
    evidence: ['auto-completed'],
    validation: { ran: false, outcome: 'not-applicable' }
  }
}
