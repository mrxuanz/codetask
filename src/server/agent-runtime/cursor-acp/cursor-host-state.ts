/**
 * Intentional mutex for Cursor host-state writes (MCP approvals / data-dir init).
 * Runtime-copy already isolates CURSOR_DATA_DIR per scope; this lock only serializes
 * concurrent host-config mutation within a process — never whole prompts, never other providers.
 */
let chain: Promise<void> = Promise.resolve()
let waitMsTotal = 0
let acquireCount = 0

export function getCursorHostStateLockStats(): { acquireCount: number; waitMsTotal: number } {
  return { acquireCount, waitMsTotal }
}

export function resetCursorHostStateLockForTests(): void {
  chain = Promise.resolve()
  waitMsTotal = 0
  acquireCount = 0
}

export async function withCursorHostStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const started = Date.now()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const prev = chain
  chain = prev.then(() => gate)
  await prev
  waitMsTotal += Date.now() - started
  acquireCount += 1
  try {
    return await fn()
  } finally {
    release()
  }
}
