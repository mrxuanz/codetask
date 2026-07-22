export type ShutdownSignal = 'SIGINT' | 'SIGTERM'

export const DEFAULT_FORCE_SHUTDOWN_MS = 10_000

export function shutdownSignalExitCode(signal: ShutdownSignal): number {
  return signal === 'SIGINT' ? 130 : 143
}

export function createShutdownSignalHandler(options: {
  shutdown: () => Promise<void>
  exit: (code: number) => void
  timeoutMs?: number
  log?: (message: string, error?: unknown) => void
}): (signal: ShutdownSignal) => void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FORCE_SHUTDOWN_MS
  let shuttingDown = false
  let exitRequested = false
  let deadline: ReturnType<typeof setTimeout> | undefined

  const requestExit = (code: number): void => {
    if (exitRequested) return
    exitRequested = true
    if (deadline !== undefined) clearTimeout(deadline)
    options.exit(code)
  }

  return (signal) => {
    const signalCode = shutdownSignalExitCode(signal)
    if (shuttingDown) {
      options.log?.(`[shutdown] received ${signal} again; forcing process exit`)
      requestExit(signalCode)
      return
    }

    shuttingDown = true
    deadline = setTimeout(() => {
      options.log?.(`[shutdown] graceful shutdown exceeded ${timeoutMs}ms; forcing process exit`)
      requestExit(signalCode)
    }, timeoutMs)
    deadline.unref?.()

    void Promise.resolve()
      .then(options.shutdown)
      .then(
        () => requestExit(0),
        (error) => {
          options.log?.('[shutdown] graceful shutdown failed; forcing process exit', error)
          requestExit(1)
        }
      )
  }
}
