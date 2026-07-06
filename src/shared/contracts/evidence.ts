export interface TaskEvidenceValidationDto {
  ran: boolean
  command?: string | null
  outcome: 'passed' | 'failed' | 'skipped' | 'not-applicable'
  notes?: string | null
}

export type TaskBlockerKind =
  | 'infra'
  | 'dependency-prep'
  | 'dependency-human'
  | 'decision'
  | 'implementation'

export interface TaskEvidenceRecoveryDto {
  kind: TaskBlockerKind
  source: 'classifier' | 'agent' | 'merged'
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
  attempt?: number
  maxAttempts?: number
  action?: 'infra-retry' | 'inject-prep' | 'inject-repair' | 'pause-human' | 'terminal-fail'
}

export interface TaskEvidenceDto {
  status: 'completed' | 'blocked' | 'failed'
  summary: string
  changedFiles: string[]
  evidence: string[]
  validation: TaskEvidenceValidationDto
  blockers?: string[]

  blockerKind?: TaskBlockerKind

  recovery?: TaskEvidenceRecoveryDto

  evidenceRef?: string

  evidenceLineCount?: number
}

export interface SliceVerificationRecordDto {
  status: string
  confidence: string
  summary: string
  evidenceTrace: Array<{
    requirement: string
    status: string
    evidence?: string[]
  }>
  satisfiedSignals?: string[]
  missingSignals?: string[]
}
