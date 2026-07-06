let seq = 0

export function isMemoryDebugEnabled(): boolean {
  return process.env.CODETASK_DEBUG_MEMORY === '1'
}

export function memoryDebug(step: string, detail?: Record<string, unknown>): void {
  if (!isMemoryDebugEnabled()) return
  seq += 1
  const mem = process.memoryUsage()
  const payload = {
    seq,
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    ...detail
  }
  console.error(`[CODETASK_DEBUG:memory] ${step} ${JSON.stringify(payload)}`)
}
