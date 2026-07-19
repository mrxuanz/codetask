const SENSITIVE_KEY =
  /^(authorization|token|password|setupToken|access_token|bearer|secret|api[_-]?key)$/i
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi
const TOKENISH_RE = /\b[a-f0-9]{32,}\b/gi

export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(BEARER_RE, 'Bearer [REDACTED]').replace(TOKENISH_RE, '[REDACTED_HASH]')
  }
  if (Array.isArray(value)) {
    return value.map(redactValue)
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(nested)
    }
    return out
  }
  return value
}

export function assertNoSecrets(payload: unknown, label: string): void {
  const text = JSON.stringify(payload)
  if (/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text)) {
    throw new Error(`security_violation:token_in_${label}`)
  }
  if (/"password"\s*:\s*"[^"]{4,}"/i.test(text)) {
    throw new Error(`security_violation:password_in_${label}`)
  }
}
