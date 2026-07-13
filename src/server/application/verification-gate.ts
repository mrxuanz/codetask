export interface VerificationQuery {
  readonly jobId: string
  readonly executionGeneration: number
  readonly planRevision: number
  readonly scopeType: 'slice' | 'milestone'
  readonly scopeId: string
}

export interface VerificationStatus {
  readonly passed: boolean
  readonly verdictBlobHash: string | null
  readonly attemptNo: number | null
}

export interface MilestoneReadiness {
  readonly milestoneId: string
  readonly ready: boolean
  readonly missingVerifications: readonly string[]
  readonly invariantViolations: readonly string[]
}

export function checkMilestoneReadiness(
  milestoneId: string,
  requiredSliceIds: readonly string[],
  verificationResults: Map<string, VerificationStatus>
): MilestoneReadiness {
  const missingVerifications: string[] = []
  const invariantViolations: string[] = []

  for (const sliceId of requiredSliceIds) {
    const verification = verificationResults.get(sliceId)

    if (!verification) {
      missingVerifications.push(sliceId)
      continue
    }

    if (!verification.passed) {
      missingVerifications.push(sliceId)
      continue
    }

    // Passed but missing verdict is invariant violation
    if (verification.verdictBlobHash === null) {
      invariantViolations.push(`verification.passed_missing_verdict:${sliceId}`)
    }
  }

  return {
    milestoneId,
    ready: missingVerifications.length === 0 && invariantViolations.length === 0,
    missingVerifications,
    invariantViolations
  }
}
