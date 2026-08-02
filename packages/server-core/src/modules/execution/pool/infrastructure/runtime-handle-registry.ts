export type RuntimeHandle = {
  runId: string
  abortController: AbortController | null
}

export class RuntimeHandleRegistry {
  private readonly handles = new Map<string, RuntimeHandle>()

  register(runId: string): RuntimeHandle {
    const handle: RuntimeHandle = { runId, abortController: null }
    this.handles.set(runId, handle)
    return handle
  }

  get(runId: string): RuntimeHandle | undefined {
    return this.handles.get(runId)
  }

  drop(runId: string): void {
    this.handles.delete(runId)
  }

  dropAll(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.abortController?.abort()
      } catch {
        // ignore
      }
    }
    this.handles.clear()
  }
}
