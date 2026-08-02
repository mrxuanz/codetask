/** Legacy workload-slot lease refresh removed with control-plane cutover. */
export async function refreshWorkloadLease(_runId: string): Promise<void> {}

/** Legacy active slot listing removed; retention uses executionRuntime registry instead. */
export async function listActiveWorkloadSlots(_filter?: {
  ownerKind?: string
  ownerId?: string
}): Promise<
  Array<{ runId: string; kind: string; ownerKind: string; ownerId: string }>
> {
  return []
}
