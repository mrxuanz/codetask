import type { TurnErrorCode } from '../../src/shared/turn-errors/codes.ts'
import { createTurnError } from '../../src/shared/turn-errors/turn-error.ts'

export interface McpToolCallResult {
  text: string
  structured?: Record<string, unknown>
}

export class McpHttpClient {
  private mcpSessionId: string | null = null
  private requestId = 1

  constructor(private readonly mcpUrl: string) {}

  async initialize(): Promise<void> {
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'workflow-test', version: '1.0.0' }
      }
    })
    if (result.error) {
      throw new Error(`MCP initialize failed: ${result.error.message}`)
    }
  }

  async listTools(): Promise<Array<{ name: string }>> {
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/list'
    })
    if (result.error) {
      throw new Error(`MCP tools/list failed: ${result.error.message}`)
    }
    const tools = (result.result as { tools?: Array<{ name: string }> })?.tools ?? []
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.post({
      jsonrpc: '2.0',
      id: this.nextId(),
      method: 'tools/call',
      params: { name, arguments: args }
    })
    if (result.error) {
      const turnErrorCode = (result.error as { data?: { turnErrorCode?: string } }).data
        ?.turnErrorCode
      if (turnErrorCode) {
        throw createTurnError(turnErrorCode as TurnErrorCode, { detail: result.error.message })
      }
      throw new Error(`MCP tool ${name} failed: ${result.error.message}`)
    }
    const payload = result.result as {
      content?: Array<{ type?: string; text?: string }>
      structuredContent?: Record<string, unknown>
    }
    const text = payload.content?.find((item) => item.type === 'text')?.text ?? ''
    return { text, structured: payload.structuredContent }
  }

  private nextId(): number {
    return this.requestId++
  }

  private async post(body: Record<string, unknown>): Promise<{
    result?: unknown
    error?: { code: number; message: string; data?: { turnErrorCode?: string } }
  }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    }
    if (this.mcpSessionId) {
      headers['Mcp-Session-Id'] = this.mcpSessionId
    }

    const response = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    const sessionHeader = response.headers.get('Mcp-Session-Id')
    if (sessionHeader) {
      this.mcpSessionId = sessionHeader
    }

    if (response.status === 202) {
      return {}
    }

    const json = (await response.json()) as {
      result?: unknown
      error?: { code: number; message: string }
    }
    return json
  }
}
