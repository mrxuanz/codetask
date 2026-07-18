import { AppError } from '../../error'
import { normalizeSliceVerificationVerdict } from '../verification/types'
import { getSliceVerifierMcpSession } from './slice-session'

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: { name?: string; arguments?: unknown }
}

export type McpDispatchResult =
  | { kind: 'notification' }
  | { kind: 'json'; body: Record<string, unknown> }

function jsonRpcOk(id: JsonRpcId, result: Record<string, unknown>): McpDispatchResult {
  return { kind: 'json', body: { jsonrpc: '2.0', id, result } }
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): McpDispatchResult {
  return { kind: 'json', body: { jsonrpc: '2.0', id, error: { code, message } } }
}

function toolTextResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: { message: text } }
}

const TOOLS = [
  {
    name: 'complete_slice_verification',
    description: 'Submit the final slice verification verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        confidence: { type: 'string' },
        summary: { type: 'string' },
        evidenceTrace: { type: 'array' },
        repairSuggestions: { type: 'array' }
      },
      required: ['status', 'confidence', 'summary']
    }
  }
]

function dispatchTool(
  sessionId: string,
  toolName: string,
  argumentsValue: unknown
): Record<string, unknown> {
  const session = getSliceVerifierMcpSession(sessionId)
  if (!session) throw AppError.badRequest(`Slice verifier session "${sessionId}" not found`)

  if (toolName !== 'complete_slice_verification') {
    throw AppError.badRequest(`Unknown tool: "${toolName}"`)
  }

  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}

  const verdict = normalizeSliceVerificationVerdict(args)
  session.resolve(verdict)
  return toolTextResult(`Accepted slice verification for ${session.sliceId}`)
}

export async function handleSliceVerifierMcpJsonRpc(
  sessionId: string,
  body: unknown
): Promise<McpDispatchResult> {
  if (!body || typeof body !== 'object') return jsonRpcError(null, -32600, 'Invalid request')

  const request = body as JsonRpcRequest
  const id = request.id ?? null
  const method = request.method ?? ''

  if (request.id === undefined && method.startsWith('notifications/'))
    return { kind: 'notification' }

  if (method === 'initialize') {
    return jsonRpcOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'codetask-slice-verifier', version: '1.0.0' }
    })
  }

  if (method === 'tools/list') return jsonRpcOk(id, { tools: TOOLS })

  if (method !== 'tools/call') {
    if (request.id === undefined) return { kind: 'notification' }
    return jsonRpcError(id, -32601, `Method not found: "${method}"`)
  }

  try {
    return jsonRpcOk(
      id,
      dispatchTool(sessionId, request.params?.name ?? '', request.params?.arguments ?? {})
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP tool failed'
    return jsonRpcError(id, -32000, message)
  }
}
