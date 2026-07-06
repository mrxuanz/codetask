import { AppError } from '../../error'
import { normalizeTaskEvidencePacket } from '../evidence/normalize'
import { getTaskMcpSession, type TaskEvidencePacket } from './task-session'

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

const TASK_MCP_TOOLS = [
  {
    name: 'report_task_result',
    description:
      'Submit the final task result with structured evidence. This is the required completion signal.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
        summary: { type: 'string', description: 'What was done or why the task stopped' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace-relative paths changed (empty array if none)'
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Concrete evidence items supporting the outcome'
        },
        validation: {
          type: 'object',
          properties: {
            ran: { type: 'boolean' },
            command: { type: 'string' },
            outcome: {
              type: 'string',
              enum: ['passed', 'failed', 'skipped', 'not-applicable']
            },
            notes: { type: 'string' }
          },
          required: ['ran', 'outcome']
        },
        blockers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required when status is blocked'
        },
        blockerKind: {
          type: 'string',
          enum: ['infra', 'dependency-prep', 'dependency-human', 'decision', 'implementation'],
          description:
            'Optional classifier hint: infra=tool/runtime failure; dependency-prep=missing workspace artifact you cannot create; dependency-human=needs operator (API key, login, reference); decision=ambiguous requirements; implementation=code cannot be completed'
        }
      },
      required: ['status', 'summary', 'changedFiles', 'evidence', 'validation']
    }
  }
]

function parseEvidencePacket(args: Record<string, unknown>): TaskEvidencePacket {
  try {
    return normalizeTaskEvidencePacket(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid task evidence'
    throw AppError.badRequest(message)
  }
}

function dispatchTool(
  sessionId: string,
  toolName: string,
  argumentsValue: unknown
): Record<string, unknown> {
  const session = getTaskMcpSession(sessionId)
  if (!session) {
    throw AppError.badRequest(`Task session "${sessionId}" not found or already closed`)
  }

  if (toolName !== 'report_task_result') {
    throw AppError.badRequest(`Unknown tool: "${toolName}"`)
  }

  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}

  const packet = parseEvidencePacket(args)
  session.resolve(packet)
  return toolTextResult(`Accepted task result for ${session.taskId}: ${packet.status}`)
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
    return jsonRpcOk(id, { tools: TASK_MCP_TOOLS })
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
