let backendPort = 0

/** Host sets this after HTTP listen (same port as conversation MCP). */
export function initExecutionMcpBackend(port: number): void {
  backendPort = port
}

export function getExecutionMcpBackendPort(): number {
  return backendPort
}
