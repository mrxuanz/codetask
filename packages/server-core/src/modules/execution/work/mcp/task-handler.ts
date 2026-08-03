import { handleReportTaskResult } from './task-result-tool.ts'
import { getTaskMcpSession } from './task-session.ts'
import { taskMcpToolDefinitions } from './task-tools.ts'

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

function toolTextResult(text: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { message: text }
  }
}

function dispatchTool(
  sessionId: string,
  toolName: string,
  argumentsValue: unknown
): Record<string, unknown> {
  const session = getTaskMcpSession(sessionId)
  if (!session) {
    throw new Error(`Task session "${sessionId}" not found or already closed`)
  }

  if (toolName !== 'report_task_result') {
    throw new Error(`Unknown tool: "${toolName}"`)
  }

  const evidence = handleReportTaskResult({ evidence: argumentsValue })
  session.resolve(evidence)
  return toolTextResult(`Accepted task result for ${session.taskId}: ${evidence.status}`)
}

export async function handleTaskMcpJsonRpc(
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
      serverInfo: { name: 'codetask-worker', version: '1.0.0' }
    })
  }

  if (method === 'tools/list') {
    return jsonRpcOk(id, { tools: taskMcpToolDefinitions() })
  }

  if (method !== 'tools/call') {
    if (request.id === undefined) return { kind: 'notification' }
    return jsonRpcError(id, -32601, `Method not found: "${method}"`)
  }

  const toolName = request.params?.name ?? ''
  const toolArguments = request.params?.arguments ?? {}

  try {
    const value = dispatchTool(sessionId, toolName, toolArguments)
    return jsonRpcOk(id, value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP tool failed'
    return jsonRpcError(id, -32000, message)
  }
}
