import type { ControlPlaneTransaction, ControlPlaneUnitOfWork } from './ports/unit-of-work'

/**
 * After each committed transaction, trigger outbox flush so realtime events publish promptly.
 */
export function withCommitFlush<T extends ControlPlaneUnitOfWork>(
  unitOfWork: T,
  onCommitted: () => void | Promise<void>
): T {
  const commit = unitOfWork.transaction.bind(unitOfWork)
  return Object.assign(unitOfWork, {
    transaction<TOut>(fn: (tx: ControlPlaneTransaction) => TOut): TOut {
      const result = commit(fn)
      void Promise.resolve(onCommitted())
      return result
    }
  })
}
