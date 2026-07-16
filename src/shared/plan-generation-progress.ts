export function resolvePlanningPercent(done: number, total: number): number {
  if (total <= 0) return 10
  if (done >= total) return 90
  if (done <= 0) return 20
  return Math.min(89, 20 + Math.round((done / total) * 70))
}
