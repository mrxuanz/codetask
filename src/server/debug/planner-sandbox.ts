import { processHostEnvironmentSource } from '../host-environment'

let seq = 0
const t0 = Date.now()

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

export function plannerSandboxDebug(step: string, detail?: unknown): void {
  if (processHostEnvironmentSource.snapshot().CODETASK_DEBUG_PLANNER_SANDBOX === '0') return
  seq += 1
  const elapsedMs = Date.now() - t0
  console.log(
    `[CODETASK_DEBUG:planner-sandbox] #${seq} +${elapsedMs}ms ${step}${formatDetail(detail)}`
  )
}
