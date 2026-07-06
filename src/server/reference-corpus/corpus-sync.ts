import type { DesignSession } from '../db/schema'
import { collectFlatPlanReferenceIds } from '../../shared/job-references'
import type { SavedJobPlan } from '../planner/plan-types'

export type CorpusRevisionFields = Pick<
  DesignSession,
  'corpusRevision' | 'frozenCorpusRevision' | 'manifestRevision'
>

export function isManifestFresh(session: CorpusRevisionFields): boolean {
  return (
    (session.manifestRevision ?? 0) >= 1 &&
    (session.frozenCorpusRevision ?? 0) === (session.corpusRevision ?? 0)
  )
}

export function referenceManifestStaleReason(session: CorpusRevisionFields): string | null {
  if ((session.manifestRevision ?? 0) < 1) {
    return 'Reference corpus has not been frozen yet'
  }
  if (!isManifestFresh(session)) {
    return 'Reference corpus changed; freeze it again before launching'
  }
  return null
}

export function findPlanReferenceIdsMissingFromCorpus(
  plan: SavedJobPlan,
  corpusIds: ReadonlySet<string>
): string[] {
  const missing: string[] = []
  for (const id of collectFlatPlanReferenceIds(plan.tasks)) {
    if (!corpusIds.has(id)) missing.push(id)
  }
  return missing
}
