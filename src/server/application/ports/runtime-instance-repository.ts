export interface RuntimeInstanceRepository {
  createRuntimeInstance(input: {
    readonly id: string
    readonly runId: string
    readonly ownerBootId: string
    readonly provider: string
    readonly pidOrHandleRef?: string | undefined
    readonly startedAtMs: number
  }): void

  closeRuntimeInstance(input: {
    readonly id: string
    readonly runId: string
    readonly closedAtMs: number
    readonly exitKind: string
    readonly exitCode?: number | undefined
    readonly signal?: string | undefined
  }): void

  getActiveInstanceForRun(
    runId: string
  ): { readonly id: string; readonly ownerBootId: string } | null

  hasClosedInstanceForRun(runId: string): boolean
}
