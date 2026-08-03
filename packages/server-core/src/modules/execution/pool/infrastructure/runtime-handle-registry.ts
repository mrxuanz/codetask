export type RuntimeHandle = {
  runId: string
  abortController: AbortController
  turnId: string | null
}

export class RuntimeHandleRegistry {
  private readonly handles = new Map<string, RuntimeHandle>()

  register(runId: string): RuntimeHandle {
    const handle: RuntimeHandle = {
      runId,
      abortController: new AbortController(),
      turnId: null
    }
    this.handles.set(runId, handle)
    return handle
  }

  get(runId: string): RuntimeHandle | undefined {
    return this.handles.get(runId)
  }

  /** Ensure a non-aborted controller exists for the run (fresh after prior abort). */
  ensureAbortController(runId: string): { signal: AbortSignal; controller: AbortController } {
    let handle = this.handles.get(runId)
    if (!handle) {
      handle = this.register(runId)
    }
    if (handle.abortController.signal.aborted) {
      handle.abortController = new AbortController()
    }
    return { signal: handle.abortController.signal, controller: handle.abortController }
  }

  setTurnId(runId: string, turnId: string | null): void {
    const handle = this.handles.get(runId)
    if (handle) handle.turnId = turnId
  }

  abort(runId: string, reason?: string): void {
    const handle = this.handles.get(runId)
    if (!handle) return
    try {
      handle.abortController.abort(reason)
    } catch {
      // ignore
    }
  }

  drop(runId: string): void {
    this.handles.delete(runId)
  }

  dropAll(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.abortController.abort()
      } catch {
        // ignore
      }
    }
    this.handles.clear()
  }
}
