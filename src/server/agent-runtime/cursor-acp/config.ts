export function resolveCursorAgentBin(): string {
  return process.env.CODETASK_CURSOR_AGENT_BIN?.trim() || 'agent'
}

export function resolveCursorApiEndpoint(): string | undefined {
  const raw = process.env.CODETASK_CURSOR_API_ENDPOINT?.trim()
  return raw || undefined
}

export function appendCursorApiEndpointArgs(args: string[]): string[] {
  const endpoint = resolveCursorApiEndpoint()
  if (!endpoint) return args
  return ['-e', endpoint, ...args]
}
