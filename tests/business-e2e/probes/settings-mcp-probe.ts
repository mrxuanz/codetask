/**
 * Phase-3 Settings MCP probe — NOT the outer Test MCP.
 * Speaks minimal JSON-RPC MCP over HTTP so SUT agents can call it once registered
 * via PUT /api/settings/mcp.
 */

import { createServer, type Server } from 'node:http'
import { PROBE_OK, PROBE_SERVER_NAME } from '../config/providers'

export type ProbeCall = {
  at: string
  tool: string
  role?: string
  args?: unknown
}

export type SettingsMcpProbeHandle = {
  name: string
  url: string
  port: number
  calls: ProbeCall[]
  /** Build OpenCode-style remote server entry for settings fragment. */
  opencodeRemoteEntry: () => Record<string, unknown>
  /** Build Cursor/Claude-style url server entry. */
  httpServerEntry: () => Record<string, unknown>
  close: () => Promise<void>
}

type JsonRpc = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export async function startSettingsMcpProbe(options?: {
  host?: string
}): Promise<SettingsMcpProbeHandle> {
  const host = options?.host ?? '127.0.0.1'
  const calls: ProbeCall[] = []

  const tools = [
    {
      name: 'probe_role',
      description: 'Return fixed PROBE_OK_* string for conversation|task|verification',
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['conversation', 'task', 'verification']
          }
        },
        required: ['role']
      }
    },
    {
      name: 'ping_conversation',
      description: 'Return PROBE_OK_CONVERSATION',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'ping_task',
      description: 'Return PROBE_OK_TASK',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'ping_verification',
      description: 'Return PROBE_OK_VERIFICATION',
      inputSchema: { type: 'object', properties: {} }
    }
  ]

  function textForTool(name: string, args: Record<string, unknown> | undefined): string {
    if (name === 'ping_conversation') return PROBE_OK.conversation
    if (name === 'ping_task') return PROBE_OK.task
    if (name === 'ping_verification') return PROBE_OK.verification
    if (name === 'probe_role') {
      const role = String(args?.role ?? '')
      if (role === 'conversation') return PROBE_OK.conversation
      if (role === 'task') return PROBE_OK.task
      if (role === 'verification') return PROBE_OK.verification
      return `PROBE_OK_UNKNOWN:${role}`
    }
    return 'PROBE_OK_UNKNOWN_TOOL'
  }

  const server: Server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, mcp-session-id, accept',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
      })
      res.end()
      return
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: PROBE_SERVER_NAME, calls: calls.length }))
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/calls')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ calls }))
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end('method_not_allowed')
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    let body: JsonRpc
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpc
    } catch {
      res.writeHead(400).end('invalid_json')
      return
    }

    const id = body.id ?? null
    const method = body.method ?? ''
    const respond = (payload: unknown): void => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      })
      res.end(JSON.stringify(payload))
    }

    if (method === 'initialize') {
      respond({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: PROBE_SERVER_NAME, version: '0.1.0' }
        }
      })
      return
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      respond({ jsonrpc: '2.0', id, result: {} })
      return
    }

    if (method === 'tools/list') {
      respond({ jsonrpc: '2.0', id, result: { tools } })
      return
    }

    if (method === 'tools/call') {
      const params = body.params ?? {}
      const toolName = String(params.name ?? '')
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? (params.arguments as Record<string, unknown>)
          : {}
      const text = textForTool(toolName, args)
      calls.push({
        at: new Date().toISOString(),
        tool: toolName,
        role: typeof args.role === 'string' ? args.role : undefined,
        args
      })
      respond({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          isError: false
        }
      })
      return
    }

    respond({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method_not_found:${method}` }
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, host, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('settings_mcp_probe_port_failed'))
    })
  })

  const url = `http://${host}:${port}/mcp`
  // Accept POST on any path (some clients hit /mcp)
  // Our handler already accepts all POST paths on this server.

  return {
    name: PROBE_SERVER_NAME,
    url: `http://${host}:${port}`,
    port,
    calls,
    opencodeRemoteEntry: () => ({
      type: 'remote',
      url: `http://${host}:${port}`,
      enabled: true,
      headers: { Accept: 'application/json, text/event-stream' }
    }),
    httpServerEntry: () => ({
      url: `http://${host}:${port}`,
      headers: { Accept: 'application/json, text/event-stream' }
    }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      })
  }
}
