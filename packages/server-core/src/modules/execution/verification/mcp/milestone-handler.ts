import { parseCompleteMilestoneVerification } from './milestone-verdict-tool.ts'
import { getMilestoneVerifierMcpSession } from './milestone-session.ts'

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

const REPAIR_TASK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    successCriteria: { type: 'string' },
    targetSliceId: { type: 'string' },
    targetWorkId: { type: 'string' },
    instruction: { type: 'string' },
    evidenceGap: { type: 'string' },
    targetTaskId: { type: 'string' }
  },
  anyOf: [
    { required: ['targetSliceId'] },
    { required: ['targetWorkId'] },
    { required: ['targetTaskId'] }
  ]
} as const

const TOOLS = [
  {
    name: 'complete_milestone_verification',
    description:
      'Submit the final milestone verification verdict. When status is needs-repair, repairTasks is required.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['passed', 'needs-repair', 'blocked', 'inconclusive']
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low']
        },
        summary: { type: 'string' },
        requirementTrace: { type: 'array' },
        sliceAssessments: { type: 'array' },
        repairTasks: {
          type: 'array',
          items: REPAIR_TASK_ITEM_SCHEMA
        }
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
  const session = getMilestoneVerifierMcpSession(sessionId)
  if (!session) throw new Error(`Milestone verifier session "${sessionId}" not found`)

  if (toolName !== 'complete_milestone_verification') {
    throw new Error(`Unknown tool: "${toolName}"`)
  }

  const verdict = parseCompleteMilestoneVerification(argumentsValue, {
    milestoneId: session.milestoneId
  })
  session.resolve(verdict)
  return toolTextResult(`Accepted milestone verification for ${session.milestoneId}`)
}

export async function handleMilestoneVerifierMcpJsonRpc(
  sessionId: string,
  body: unknown
): Promise<McpDispatchResult> {
  if (!body || typeof body !== 'object') return jsonRpcError(null, -32600, 'Invalid request')

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
      serverInfo: { name: 'codetask-milestone-verifier', version: '1.0.0' }
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
