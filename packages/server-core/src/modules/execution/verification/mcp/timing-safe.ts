import { timingSafeEqual } from 'crypto'

export function timingSafeStringEqual(
  actual: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (actual == null || expected == null) return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
