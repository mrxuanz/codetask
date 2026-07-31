/** Per-draft run configuration (planner + verifiers). Mirrors product DraftExecutionConfig. */
export type DraftExecutionConfig = {
  plannerCoreCode: string
  sliceVerifierCoreCode: string
  milestoneVerifierCoreCode: string
}

export function draftExecutionConfigFromRoles(roles: {
  planner: string
  sliceVerifier: string
  milestoneVerifier: string
}): DraftExecutionConfig {
  return {
    plannerCoreCode: roles.planner,
    sliceVerifierCoreCode: roles.sliceVerifier,
    milestoneVerifierCoreCode: roles.milestoneVerifier
  }
}

export function executionProfileCoresMatch(
  profile: unknown,
  expected: DraftExecutionConfig
): boolean {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false
  const record = profile as Record<string, unknown>
  return (
    record.plannerCoreCode === expected.plannerCoreCode &&
    record.sliceVerifierCoreCode === expected.sliceVerifierCoreCode &&
    record.milestoneVerifierCoreCode === expected.milestoneVerifierCoreCode
  )
}
