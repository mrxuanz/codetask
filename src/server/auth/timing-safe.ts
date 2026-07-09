import { timingSafeEqual as cryptoTimingSafeEqual } from 'crypto'

/** Constant-time string compare; length mismatch returns false without leaking content. */
export function timingSafeStringEqual(
  actual: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (actual == null || expected == null) return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return cryptoTimingSafeEqual(a, b)
}
