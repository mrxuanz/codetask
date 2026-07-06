const MAX_CONCURRENT = 4
const MAX_QUEUE = 64
const QUEUE_TIMEOUT_MS = 5000

interface QueueEntry {
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let active = 0
const queue: QueueEntry[] = []

function processQueue(): void {
  while (queue.length > 0 && active < MAX_CONCURRENT) {
    const entry = queue.shift()!
    clearTimeout(entry.timeout)
    active++
    let released = false
    entry.resolve(() => {
      if (!released) {
        released = true
        active--
        processQueue()
      }
    })
  }
}

export function acquirePasswordSlot(): Promise<() => void> {
  if (active < MAX_CONCURRENT && queue.length === 0) {
    active++
    let released = false
    return Promise.resolve(() => {
      if (!released) {
        released = true
        active--
        processQueue()
      }
    })
  }

  return new Promise<() => void>((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      reject(new Error('Password verification queue full, please retry'))
      return
    }

    const timeout = setTimeout(() => {
      const idx = queue.findIndex((e) => e.timeout === timeout)
      if (idx !== -1) {
        queue.splice(idx, 1)
        reject(new Error('Password verification capacity exceeded, please retry'))
      }
    }, QUEUE_TIMEOUT_MS)

    queue.push({ resolve, reject, timeout })
  })
}
