export type RuntimeHandleKind = 'cursor-acp' | 'sandbox-worker' | 'job-cursor-pool'

export interface RuntimeHandle {
  kind: RuntimeHandleKind
  cancel?: () => Promise<void>
  close?: () => Promise<void>
  kill?: () => Promise<void>
  waitClosed?: () => Promise<void>
  pid?: number
}

interface RegisteredHandle {
  runId: string
  handle: RuntimeHandle
}

const handles = new Map<string, RegisteredHandle>()

export function registerRunRuntime(runId: string, handle: RuntimeHandle): void {
  handles.set(runId, { runId, handle })
}

export function unregisterRunRuntime(runId: string): void {
  handles.delete(runId)
}

export function getRunRuntime(runId: string): RuntimeHandle | undefined {
  return handles.get(runId)?.handle
}

export function hasRunRuntime(runId: string): boolean {
  return handles.has(runId)
}

export function resetRuntimeSupervisorForTests(): void {
  handles.clear()
}

export async function cancelRun(runId: string, _reason?: string): Promise<void> {
  const entry = handles.get(runId)
  if (!entry) return
  if (entry.handle.cancel) {
    await entry.handle.cancel().catch((error) => {
      console.warn('[runtime-supervisor] cancel failed', runId, error)
    })
  }
}

export async function stopRun(runId: string, _reason?: string): Promise<void> {
  const entry = handles.get(runId)
  if (!entry) return
  if (entry.handle.close) {
    await entry.handle.close().catch((error) => {
      console.warn('[runtime-supervisor] close failed', runId, error)
    })
  }
}

export async function hardKill(runId: string): Promise<void> {
  const entry = handles.get(runId)
  if (!entry) return
  if (entry.handle.kill) {
    await entry.handle.kill().catch((error) => {
      console.warn('[runtime-supervisor] kill failed', runId, error)
    })
  }
}

export async function waitClosed(runId: string, timeoutMs = 30_000): Promise<void> {
  const entry = handles.get(runId)
  if (!entry) return
  if (!entry.handle.waitClosed) return

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entry.handle.waitClosed(),
      new Promise<void>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`waitClosed timeout for ${runId}`))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
  }
}

export async function closeRunRuntime(runId: string): Promise<void> {
  const entry = handles.get(runId)
  if (!entry) return
  if (entry.handle.close) {
    try {
      await entry.handle.close()
    } catch (error) {
      console.warn('[runtime-supervisor] close failed', runId, error)
      throw error
    }
  }
  handles.delete(runId)
}
