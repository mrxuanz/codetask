import type { ExecutionJob } from '@renderer/api/jobs-api'

/**
 * Merge authoritative list/detail snapshots without treating Job state revision as
 * the revision of the nested work tree. Work progress can change while the Job
 * state revision stays constant, so a same-revision detail snapshot must replace
 * the tree while a list snapshot must preserve an already loaded tree.
 */
export function mergeExecutionJobSnapshot(
  existing: ExecutionJob | null | undefined,
  incoming: ExecutionJob
): ExecutionJob {
  if (typeof incoming.stateRevision !== 'number') {
    throw new Error('Execution job is missing its state revision')
  }
  if (existing && incoming.stateRevision < existing.stateRevision) return existing

  const hasTree = Object.prototype.hasOwnProperty.call(incoming, 'tree')
  return {
    ...(existing ?? ({} as ExecutionJob)),
    ...incoming,
    ...(hasTree ? { tree: incoming.tree } : existing?.tree ? { tree: existing.tree } : {})
  }
}
