let enabled = false
let seq = 0
const t0 = Date.now()

/** Host bootstrap may enable verbose sandbox-turn tracing. */
export function configureSandboxTurnDebug(options: { enabled: boolean }): void {
  enabled = options.enabled
  seq = 0
}

function formatDetail(detail: unknown): string {
  if (detail === undefined) return ''
  try {
    return ` ${JSON.stringify(detail, (_key, value) => {
      if (typeof value === 'string' && value.length > 240) {
        return `${value.slice(0, 240)}…`
      }
      return value
    })}`
  } catch {
    return ` ${String(detail)}`
  }
}

export function sandboxTurnDebug(step: string, detail?: unknown): void {
  if (!enabled) return
  seq += 1
  const elapsedMs = Date.now() - t0
  const line = `[CODETASK_DEBUG:sandbox] #${seq} +${elapsedMs}ms ${step}${formatDetail(detail)}\n`
  process.stderr.write(line)
}

export const plannerSandboxDebug = sandboxTurnDebug
