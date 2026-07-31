/** Marks the current process as the sandbox supervisor worker (forked child). */
let supervisorWorker = false

export function markSandboxSupervisorWorker(): void {
  supervisorWorker = true
}

export function isSandboxSupervisorWorker(): boolean {
  return supervisorWorker
}

/** @internal test helper */
export function resetSandboxSupervisorWorkerForTests(): void {
  supervisorWorker = false
}
