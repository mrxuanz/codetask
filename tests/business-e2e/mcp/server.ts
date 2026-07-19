import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { PublicApiClient } from '../api/client'
import type { OperationLedger } from '../reports/ledger'
import { CapabilityStore } from './capabilities'
import { invokeTool, listToolsForCapability, TOOL_DEFS } from './tools'

export type TestMcpHandle = {
  url: string
  port: number
  capabilities: CapabilityStore
  close: () => Promise<void>
}

type JsonRpcRequest = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export async function startTestMcpServer(options: {
  client: PublicApiClient
  ledger: OperationLedger
  host?: string
}): Promise<TestMcpHandle> {
  const capabilities = new CapabilityStore()
  const sessions = new Map<string, { capabilityId: string }>()
  const host = options.host ?? '127.0.0.1'

  const server: Server = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, mcp-session-id, x-business-capability',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
      })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${host}`)
    if (req.method === 'GET' && url.pathname === '/capability-report') {
      const capabilityId = url.searchParams.get('capabilityId') ?? ''
      const capability = capabilities.get(capabilityId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          found: Boolean(capability),
          revoked: capability?.revoked ?? false,
          report: capability?.agentReport ?? null,
          checkpoints: capability?.checkpoints ?? []
        })
      )
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end('method_not_allowed')
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    let body: JsonRpcRequest
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest
    } catch {
      res.writeHead(400).end('invalid_json')
      return
    }

    const capabilityId =
      (typeof req.headers['x-business-capability'] === 'string'
        ? req.headers['x-business-capability']
        : undefined) ??
      (typeof body.params?.capabilityId === 'string' ? body.params.capabilityId : undefined) ??
      sessions.get(String(req.headers['mcp-session-id'] ?? ''))?.capabilityId

    const respond = (payload: unknown, sessionId?: string): void => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
      if (sessionId) headers['Mcp-Session-Id'] = sessionId
      res.writeHead(200, headers)
      res.end(JSON.stringify(payload))
    }

    const id = body.id ?? null
    const method = body.method ?? ''

    if (method === 'initialize') {
      if (
        !capabilityId ||
        !capabilities.get(capabilityId) ||
        capabilities.get(capabilityId)?.revoked
      ) {
        respond({
          jsonrpc: '2.0',
          id,
          error: { code: -32001, message: 'capability_required' }
        })
        return
      }
      const sessionId = randomBytes(8).toString('hex')
      sessions.set(sessionId, { capabilityId })
      respond(
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'codetask-business-test-mcp', version: '0.1.0' }
          }
        },
        sessionId
      )
      return
    }

    if (method === 'notifications/initialized') {
      res.writeHead(202).end()
      return
    }

    if (!capabilityId) {
      respond({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: 'capability_required' }
      })
      return
    }

    if (method === 'tools/list') {
      const tools = listToolsForCapability(capabilityId, capabilities).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
      respond({ jsonrpc: '2.0', id, result: { tools } })
      return
    }

    if (method === 'tools/call') {
      const name = String((body.params as { name?: string })?.name ?? '')
      const args = ((body.params as { arguments?: Record<string, unknown> })?.arguments ??
        {}) as Record<string, unknown>
      try {
        const result = await invokeTool(name, args, {
          capabilityId,
          client: options.client,
          capabilities,
          ledger: options.ledger
        })
        respond({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result.content) }],
            structuredContent:
              result.content && typeof result.content === 'object' && !Array.isArray(result.content)
                ? result.content
                : { data: result.content },
            isError: !result.ok
          }
        })
      } catch (error) {
        respond({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: String(error) }
        })
      }
      return
    }

    respond({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method_not_found:${method}` }
    })
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('mcp_port_alloc_failed'))
    })
  })

  return {
    url: `http://${host}:${port}/mcp`,
    port,
    capabilities,
    close: () =>
      new Promise((resolve, reject) => {
        capabilities.revokeAll()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

export { TOOL_DEFS }
