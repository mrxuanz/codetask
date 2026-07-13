import { existsSync, realpathSync } from 'fs'
import {
  collectFlatPlanReferenceIds,
  parseJobReferenceManifest,
  validateReferenceCoverage,
  type JobReferenceManifest
} from '../../shared/job-references'
import type { JobSnapshot } from '../../shared/contracts/job-snapshot'
import type { ThreadJobAbilityDto } from '../legacy-control-plane/types'
import type { SavedJobPlan } from '../planner/plan-types'
import type { ThreadJob } from '../db/schema'
import { AppError } from '../error'
import { ReferenceFileMissingError } from '../legacy-control-plane/reference-paths'
import { referenceManifestStaleReason } from '../reference-corpus/corpus-sync'

export function assertManifestResolvedPathsReadable(manifest: JobReferenceManifest): void {
  for (const ref of manifest.references) {
    const path = ref.resolvedPath?.trim()
    if (!path) continue
    if (!existsSync(path)) {
      throw new ReferenceFileMissingError(ref.id, ref.name, path)
    }
    try {
      realpathSync(path)
    } catch {
      throw new ReferenceFileMissingError(ref.id, ref.name, path)
    }
  }
}

export function buildJobSnapshot(input: {
  session: ThreadJob
  plan: SavedJobPlan
  abilities: ThreadJobAbilityDto[]
  manifest: JobReferenceManifest
}): JobSnapshot {
  return {
    designSessionId: input.session.id,
    draftRevision: input.session.draftRevision,
    planRevision: input.session.planRevision,
    manifestRevision: input.session.manifestRevision,
    workspaceRoot: input.session.workspacePath,
    referenceManifest: input.manifest,
    executionPlan: input.plan,
    abilities: input.abilities
  }
}

export function validateLaunchPreconditions(input: {
  session: ThreadJob
  plan: SavedJobPlan | null
  manifest: JobReferenceManifest | null
}): void {
  const { session, plan, manifest } = input

  if (session.planConfirmedAt != null || session.phase === 'archived') {
    throw AppError.badRequest('Design session already launched', 'job.already_launched')
  }
  if (session.status !== 'plan_editing') {
    throw AppError.badRequest(
      'Only a plan ready to launch can be submitted',
      'job.invalid_status',
      { status: session.status }
    )
  }
  if (!manifest || (session.manifestRevision ?? 0) < 1) {
    throw AppError.badRequest('Reference manifest is not ready', 'draft.manifest_not_ready')
  }
  const staleReason = referenceManifestStaleReason(session)
  if (staleReason) {
    throw AppError.badRequest('Reference manifest is stale', 'draft.manifest_not_ready', {
      reason: staleReason
    })
  }
  if (!plan?.tasks?.length) {
    throw AppError.badRequest('Execution plan is empty', 'job.plan_empty')
  }
  const coverageErrors = validateReferenceCoverage(
    collectFlatPlanReferenceIds(plan.tasks),
    manifest
  )
  if (coverageErrors.length > 0) {
    throw AppError.badRequest('References not assigned to tasks', 'draft.references_uncovered', {
      references: coverageErrors.join(', ')
    })
  }

  assertManifestResolvedPathsReadable(manifest)
}

export function parseSessionManifest(session: ThreadJob): JobReferenceManifest | null {
  return parseJobReferenceManifest(session.referenceManifestJson)
}
