export class McpToolClient {
  private sessionId: string | null = null
  private requestId = 1

  constructor(
    private readonly mcpUrl: string,
    private readonly capabilityId: string
  ) {}

  async initialize(): Promise<void> {
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'business-e2e-driver', version: '0.1.0' },
        capabilityId: this.capabilityId
      }
    })
    if (result.error) throw new Error(`mcp_initialize_failed:${result.error.message}`)
    await this.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    })
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/call',
      params: { name, arguments: args }
    })
    if (result.error) throw new Error(`mcp_tool_failed:${name}:${result.error.message}`)
    const payload = result.result as {
      isError?: boolean
      structuredContent?: unknown
      content?: Array<{ text?: string }>
    }
    if (payload?.isError) {
      throw new Error(`mcp_tool_error:${name}:${payload.content?.[0]?.text ?? 'unknown'}`)
    }
    const structured = payload?.structuredContent
    if (
      structured &&
      typeof structured === 'object' &&
      !Array.isArray(structured) &&
      'data' in structured &&
      Object.keys(structured as object).length === 1
    ) {
      return (structured as { data: unknown }).data
    }
    return structured ?? payload
  }

  private nextId(): number {
    return this.requestId++
  }

  private async post(body: Record<string, unknown>): Promise<{
    result?: unknown
    error?: { code: number; message: string }
  }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Business-Capability': this.capabilityId
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId
    const response = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    const session = response.headers.get('Mcp-Session-Id')
    if (session) this.sessionId = session
    if (response.status === 202) return {}
    return (await response.json()) as {
      result?: unknown
      error?: { code: number; message: string }
    }
  }
}
