import type { TaskEvidenceDto } from '@shared/contracts/evidence'
import type { TurnErrorDto } from '@shared/contracts/turn-errors'

export type TaskBlockerKind =
  | 'infra'
  | 'dependency-prep'
  | 'dependency-human'
  | 'decision'
  | 'implementation'

export type TaskBlockerKindSource = 'classifier' | 'agent' | 'merged'

export interface TaskBlockerClassification {
  kind: TaskBlockerKind
  source: TaskBlockerKindSource
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
}

type RecoveryActionBase = {
  message: string
  error: TurnErrorDto
  classification: TaskBlockerClassification
}

export type TaskRecoveryAction =
  | (RecoveryActionBase & {
      action: 'infra-retry'
      attempt: number
      maxAttempts: number
      delayMs: number
    })
  | (RecoveryActionBase & {
      action: 'inject-prep'
      attempt: number
      maxAttempts: number
      newTaskIds: string[]
    })
  | (RecoveryActionBase & {
      action: 'inject-repair'
      attempt: number
      maxAttempts: number
      newTaskIds: string[]
    })
  | (RecoveryActionBase & {
      action: 'pause-human'
    })
  | (RecoveryActionBase & {
      action: 'terminal-fail'
    })

export type TaskEvidencePacket = TaskEvidenceDto
