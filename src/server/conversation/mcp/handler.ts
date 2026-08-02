import { AppError } from '../../error'
import { resolveMessageAttachmentAbsolutePath, readThreadAttachment } from '../attachments'
import { conversationMcpToolDefinitions } from './tools'
import { getConversationMcpSession } from './session'

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: {
    name?: string
    arguments?: unknown
  }
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

function toolTextResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  }
}

async function dispatchTool(
  sessionId: string,
  toolName: string,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const session = getConversationMcpSession(sessionId)
  if (!session) {
    throw AppError.badRequest(`Agent session "${sessionId}" not found or already closed`)
  }

  switch (toolName) {
    case 'read_reference_attachment': {
      const attachmentId =
        argumentsValue &&
        typeof argumentsValue === 'object' &&
        typeof (argumentsValue as Record<string, unknown>).attachmentId === 'string'
          ? ((argumentsValue as Record<string, unknown>).attachmentId as string).trim()
          : ''
      if (!attachmentId) {
        throw AppError.badRequest('attachmentId is required')
      }
      const attachment = session.turnAttachments.find((item) => item.id === attachmentId)
      if (!attachment) {
        return { ok: false, message: 'Attachment not found in this turn' }
      }
      const ownerId = session.conversationId || session.threadId
      const stored = readThreadAttachment(ownerId, attachmentId)
      if (!stored) {
        return { ok: false, message: 'Attachment file does not exist' }
      }
      if (stored.attachment.kind === 'image') {
        const absolutePath = resolveMessageAttachmentAbsolutePath(ownerId, stored.attachment)
        return {
          ok: true,
          attachmentId,
          name: stored.attachment.name,
          mimeType: stored.attachment.mimeType,
          kind: 'image',
          ...(absolutePath ? { path: absolutePath } : {}),
          note: 'Use the Read tool with path to inspect this image.'
        }
      }
      const text = stored.buffer.toString('utf-8')
      return {
        ok: true,
        attachmentId,
        name: stored.attachment.name,
        mimeType: stored.attachment.mimeType,
        kind: 'file',
        text: text.slice(0, 12000)
      }
    }
    default:
      throw AppError.badRequest(`Unknown tool: "${toolName}"`)
  }
}

export async function handleConversationMcpJsonRpc(
  sessionId: string,
  body: unknown
): Promise<McpDispatchResult> {
  if (!body || typeof body !== 'object') {
    return jsonRpcError(null, -32600, 'Invalid request')
  }

  const request = body as JsonRpcRequest
  const id = request.id ?? null
  const method = request.method ?? ''

  if (request.id === undefined && method.startsWith('notifications/')) {
    return { kind: 'notification' }
  }

  if (method === 'initialize') {
    return jsonRpcOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'codetask-conversation', version: '1.0.0' }
    })
  }

  if (method === 'tools/list') {
    return jsonRpcOk(id, { tools: conversationMcpToolDefinitions() })
  }

  if (method !== 'tools/call') {
    if (request.id === undefined) return { kind: 'notification' }
    return jsonRpcError(id, -32601, `Method not found: "${method}"`)
  }

  const toolName = request.params?.name ?? ''
  const toolArguments = request.params?.arguments ?? {}

  try {
    const value = await dispatchTool(sessionId, toolName, toolArguments)
    console.info('[conversation-mcp] tools/call ok', { sessionId, toolName })
    return jsonRpcOk(id, toolTextResult(value))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP tool failed'
    console.warn('[conversation-mcp] tools/call failed', { sessionId, toolName, message })
    return jsonRpcError(id, -32000, message)
  }
}

export function handleStubMcpJsonRpc(serverName: string, body: unknown): McpDispatchResult {
  if (!body || typeof body !== 'object') {
    return jsonRpcError(null, -32600, 'Invalid request')
  }
  const request = body as JsonRpcRequest
  const id = request.id ?? null
  const method = request.method ?? ''

  if (request.id === undefined && method.startsWith('notifications/')) {
    return { kind: 'notification' }
  }

  if (method === 'initialize') {
    return jsonRpcOk(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: serverName, version: '1.0.0' }
    })
  }

  if (method === 'tools/list') {
    return jsonRpcOk(id, { tools: [] })
  }

  if (method === 'tools/call') {
    return jsonRpcError(id, -32000, 'MCP orchestration is not enabled for this role')
  }

  if (request.id === undefined) return { kind: 'notification' }
  return jsonRpcError(id, -32601, `Method not found: "${method}"`)
}
