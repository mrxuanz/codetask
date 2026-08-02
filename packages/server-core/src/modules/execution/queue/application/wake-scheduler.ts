export type WakeSchedulerFn = () => void

let wakeFn: WakeSchedulerFn | null = null

export function registerWakeScheduler(fn: WakeSchedulerFn): void {
  wakeFn = fn
}

export function wakeScheduler(): void {
  wakeFn?.()
}

export function createWakeScheduler(onWake: () => void): WakeSchedulerFn {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      onWake()
    })
  }
}
