import { DEFAULT_RETENTION_SETTINGS } from '../../shared/contracts/retention.ts'
import type { TaskEvidenceDto } from '../../shared/contracts/evidence.ts'
import type { SliceVerificationRecordDto } from '../../shared/contracts/evidence.ts'

export function shouldExternalizeEvidence(
  evidence: TaskEvidenceDto,
  maxBytes = DEFAULT_RETENTION_SETTINGS.artifactInlineMaxBytes
): boolean {
  return Buffer.byteLength(JSON.stringify(evidence), 'utf8') > maxBytes
}

export function summarizeEvidence(evidence: TaskEvidenceDto): string {
  const summary = evidence.summary?.trim()
  if (summary) return summary.slice(0, 512)
  const first = evidence.evidence?.[0]?.trim()
  if (first) return first.slice(0, 512)
  return evidence.status
}

export function slimEvidenceForState(evidence: TaskEvidenceDto): TaskEvidenceDto {
  return {
    status: evidence.status,
    summary: evidence.summary,
    changedFiles: evidence.changedFiles,
    evidence: [],
    validation: evidence.validation,
    blockers: evidence.blockers,
    blockerKind: evidence.blockerKind,
    recovery: evidence.recovery,
    evidenceLineCount: evidence.evidence?.length ?? evidence.evidenceLineCount
  }
}

const SLICE_VERDICT_INLINE_MAX = 2048

export function shouldExternalizeSliceVerdict(verdict: SliceVerificationRecordDto): boolean {
  return Buffer.byteLength(JSON.stringify(verdict), 'utf8') > SLICE_VERDICT_INLINE_MAX
}

export function slimSliceVerdict(verdict: SliceVerificationRecordDto): SliceVerificationRecordDto {
  return {
    status: verdict.status,
    confidence: verdict.confidence,
    summary: verdict.summary,
    evidenceTrace: [],
    satisfiedSignals: verdict.satisfiedSignals,
    missingSignals: verdict.missingSignals
  }
}
