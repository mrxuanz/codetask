import {
  DEFAULT_RETENTION_POLICY,
  selectEligibleArtifacts,
  type RetentionPolicy
} from '../../domain/retention/index'
import type { ApplicationDependencies } from '../dependencies'

export type RetentionWorkInput = {
  readonly policy?: RetentionPolicy
  readonly nowMs?: number
}

export type RetentionWorkResult = {
  readonly deletedIds: readonly string[]
  readonly deletedCount: number
}

/**
 * Delete (soft) artifacts whose retention TTL has expired.
 */
export async function retentionWork(
  deps: ApplicationDependencies,
  input: RetentionWorkInput = {}
): Promise<RetentionWorkResult> {
  const nowMs = input.nowMs ?? deps.clock.now().getTime()
  const policy = input.policy ?? DEFAULT_RETENTION_POLICY
  void policy // policy applied at write-time via expiresAtMs; eligibility is pure.

  const all = await deps.retention.list()
  const eligible = selectEligibleArtifacts(all, nowMs)

  const deletedIds: string[] = []
  await deps.unitOfWork.run(async (tx) => {
    for (const artifact of eligible) {
      await deps.retention.markDeleted(artifact.id, nowMs)
      deletedIds.push(artifact.id)
      tx.enqueueEvent({
        type: 'retention.artifact_deleted',
        aggregateId: artifact.id
      })
    }
  })

  return { deletedIds, deletedCount: deletedIds.length }
}
