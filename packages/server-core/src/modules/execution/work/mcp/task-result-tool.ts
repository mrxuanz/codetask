import type { TaskEvidence } from '@codetask/contracts'
import { validateTaskEvidence } from '../../verification/domain/task-evidence.ts'

export function parseTaskResultToolArgs(args: unknown): TaskEvidence {
  return handleReportTaskResult({ evidence: args })
}

/** Validates MCP task-result payload and returns canonical TaskEvidence. */
export function handleReportTaskResult(input: { evidence: unknown }): TaskEvidence {
  const evidence = input.evidence as TaskEvidence
  validateTaskEvidence(evidence)
  return evidence
}
