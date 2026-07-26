/**
 * Localhost MCP endpoint allowlist enforcement (重构.md §10.6).
 * Default deny: undeclared loopback ports are rejected.
 */

export class McpAllowlistError extends Error {
  constructor(
    message: string,
    readonly code: 'runtime.mcp.denied' | 'runtime.mcp.invalid'
  ) {
    super(message)
    this.name = 'McpAllowlistError'
  }
}

function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new McpAllowlistError('MCP endpoint is empty', 'runtime.mcp.invalid')
  }

  // Accept bare host:port
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return `http://${trimmed}`.toLowerCase()
  }

  try {
    const url = new URL(trimmed)
    const port =
      url.port ||
      (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '')
    const host = url.hostname.toLowerCase()
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return `${url.protocol}//${host}${port ? `:${port}` : ''}${path}`.toLowerCase()
  } catch {
    throw new McpAllowlistError(
      `Invalid MCP endpoint URL: ${raw}`,
      'runtime.mcp.invalid'
    )
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * Returns true when `endpoint` is an exact (normalized) match of an allowlist entry.
 */
export function isLocalhostMcpAllowed(
  endpoint: string,
  allowlist: readonly string[]
): boolean {
  if (allowlist.length === 0) return false
  let normalized: string
  try {
    normalized = normalizeEndpoint(endpoint)
  } catch {
    return false
  }

  try {
    const url = new URL(normalized)
    if (!isLoopbackHost(url.hostname)) return false
  } catch {
    return false
  }

  const allowed = new Set(allowlist.map((entry) => normalizeEndpoint(entry)))
  return allowed.has(normalized)
}

export function assertMcpEndpointAllowed(
  endpoint: string,
  allowlist: readonly string[]
): void {
  if (isLocalhostMcpAllowed(endpoint, allowlist)) return
  throw new McpAllowlistError(
    `Localhost MCP endpoint not on allowlist: ${endpoint}`,
    'runtime.mcp.denied'
  )
}
