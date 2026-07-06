import type {
  TaskEvidenceDto,
  TaskEvidenceValidationDto,
  TaskBlockerKind
} from '@shared/contracts/evidence'
import { parseChangedFilePaths } from './paths'

export type TaskEvidencePacket = TaskEvidenceDto

const BLOCKER_KINDS = new Set<TaskBlockerKind>([
  'infra',
  'dependency-prep',
  'dependency-human',
  'decision',
  'implementation'
])

function parseBlockerKind(raw: unknown): TaskBlockerKind | undefined {
  const value = nonEmpty(raw)
  if (!value || !BLOCKER_KINDS.has(value as TaskBlockerKind)) return undefined
  return value as TaskBlockerKind
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`)
  }
  const items = value.map((item, index) => {
    const text = nonEmpty(item)
    if (!text) throw new Error(`${field}[${index}] must be a non-empty string`)
    return text
  })
  return items
}

function parseValidation(raw: unknown): TaskEvidenceValidationDto {
  if (!raw || typeof raw !== 'object') {
    throw new Error('validation must be an object')
  }
  const row = raw as Record<string, unknown>
  if (typeof row.ran !== 'boolean') {
    throw new Error('validation.ran must be a boolean')
  }
  const outcome = nonEmpty(row.outcome)
  if (!outcome || !['passed', 'failed', 'skipped', 'not-applicable'].includes(outcome)) {
    throw new Error('validation.outcome must be passed, failed, skipped, or not-applicable')
  }
  return {
    ran: row.ran,
    command: nonEmpty(row.command) ?? null,
    outcome: outcome as TaskEvidenceValidationDto['outcome'],
    notes: nonEmpty(row.notes) ?? null
  }
}

export function normalizeTaskEvidencePacket(raw: Record<string, unknown>): TaskEvidencePacket {
  const status = nonEmpty(raw.status)
  if (status !== 'completed' && status !== 'blocked' && status !== 'failed') {
    throw new Error('status must be completed, blocked, or failed')
  }

  const summary = nonEmpty(raw.summary)
  if (!summary) throw new Error('summary is required')

  const evidence = parseStringArray(raw.evidence, 'evidence')
  if (evidence.length === 0) {
    throw new Error('evidence must include at least one item')
  }

  const validation = parseValidation(raw.validation)
  const blockers = Array.isArray(raw.blockers)
    ? raw.blockers.map((item) => nonEmpty(item)).filter((item): item is string => Boolean(item))
    : undefined

  if (status === 'blocked') {
    if (!blockers?.length) {
      throw new Error('blockers is required when status is blocked')
    }
    return {
      status,
      summary,
      changedFiles: parseChangedFilePaths(raw.changedFiles, { required: false }),
      evidence,
      validation,
      blockers,
      blockerKind: parseBlockerKind(raw.blockerKind)
    }
  }

  const changedFiles = parseChangedFilePaths(raw.changedFiles, { required: true })

  if (status === 'completed' && validation.outcome === 'not-applicable' && !validation.ran) {
    // no-op: allow completed tasks with not-applicable validation
  }

  return {
    status,
    summary,
    changedFiles,
    evidence,
    validation,
    blockers: blockers?.length ? blockers : undefined,
    blockerKind: parseBlockerKind(raw.blockerKind)
  }
}

export function formatTaskEvidenceForPrompt(evidence: TaskEvidenceDto): string {
  const lines = [
    `status: ${evidence.status}`,
    `summary: ${evidence.summary}`,
    `changedFiles: ${evidence.changedFiles.length ? evidence.changedFiles.join(', ') : '(none)'}`,
    'evidence:',
    ...evidence.evidence.map((item) => `  - ${item}`),
    `validation: ran=${evidence.validation.ran}, outcome=${evidence.validation.outcome}${
      evidence.validation.command ? `, command=${evidence.validation.command}` : ''
    }${evidence.validation.notes ? `, notes=${evidence.validation.notes}` : ''}`
  ]
  if (evidence.blockers?.length) {
    lines.push('blockers:', ...evidence.blockers.map((item) => `  - ${item}`))
  }
  if (evidence.blockerKind) {
    lines.push(`blockerKind: ${evidence.blockerKind}`)
  }
  if (evidence.recovery) {
    lines.push(
      `recovery: kind=${evidence.recovery.kind}, action=${evidence.recovery.action ?? '-'}, source=${evidence.recovery.source}`
    )
  }
  return lines.join('\n')
}
