export type TaskEvidenceValidationDto = {
  ran: boolean
  command?: string | null | undefined
  outcome: 'passed' | 'failed' | 'skipped' | 'not-applicable'
  notes?: string | null | undefined
}

export type TaskBlockerKind =
  | 'infra'
  | 'dependency-prep'
  | 'dependency-human'
  | 'decision'
  | 'implementation'

export type TaskEvidenceRecoveryDto = {
  kind: TaskBlockerKind
  source: 'classifier' | 'agent' | 'merged'
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
  attempt?: number | undefined
  maxAttempts?: number | undefined
  action?:
    | 'infra-retry'
    | 'inject-prep'
    | 'inject-repair'
    | 'pause-human'
    | 'terminal-fail'
    | undefined
}

export type TaskEvidenceDto = {
  status: 'completed' | 'blocked' | 'failed'
  summary: string
  changedFiles: string[]
  evidence: string[]
  validation: TaskEvidenceValidationDto
  blockers?: string[] | undefined
  blockerKind?: TaskBlockerKind | undefined
  recovery?: TaskEvidenceRecoveryDto | undefined
  evidenceRef?: string | undefined
  evidenceLineCount?: number | undefined
}

export type SliceVerificationRecordDto = {
  status: string
  summary?: string | null | undefined
  [key: string]: unknown
}
