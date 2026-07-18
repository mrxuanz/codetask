import { AsyncLocalStorage } from 'node:async_hooks'
import type { WorkspaceLeaseOwnerKind } from './workspace-lease-store'

export interface WorkspaceLeaseContext {
  leaseId: string
  ownerKind: WorkspaceLeaseOwnerKind
  ownerId: string
}

const storage = new AsyncLocalStorage<WorkspaceLeaseContext>()

export function runWithWorkspaceLeaseContext<T>(
  context: WorkspaceLeaseContext,
  fn: () => T
): T {
  return storage.run(context, fn)
}

export function getWorkspaceLeaseContext(): WorkspaceLeaseContext | undefined {
  return storage.getStore()
}

/** Bind lease context for the current async chain (e.g. conversation async generators). */
export function enterWorkspaceLeaseContext(context: WorkspaceLeaseContext): void {
  storage.enterWith(context)
}

export async function runWithWorkspaceLeaseContextAsync<T>(
  context: WorkspaceLeaseContext,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(context, fn)
}
