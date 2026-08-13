const REDACTED = '[REDACTED]'
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|oauth|pass(?:word)?|secret|session|token|api[-_]?key)/i

export function scrubLogString(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE)[A-Z0-9_]*)\s*=\s*([^\s,;]+)/g,
      `$1=${REDACTED}`
    )
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*([^\s,;]+)/gi,
      `$1=${REDACTED}`
    )
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\/Users\/[^/\s]+/g, '/Users/[USER]')
    .replace(/\/home\/[^/\s]+/g, '/home/[USER]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gi, 'C:\\Users\\[USER]')
}

export function scrubLogValue(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED
  if (typeof value === 'string') return scrubLogString(value)
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubLogString(value.message),
      ...(value.stack ? { stack: scrubLogString(value.stack) } : {})
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubLogValue(entry, undefined, seen))
  }

  const scrubbed: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value)) {
    scrubbed[entryKey] = scrubLogValue(entryValue, entryKey, seen)
  }
  return scrubbed
}
