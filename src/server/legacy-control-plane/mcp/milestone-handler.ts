import { AppError } from '../../error'
import { normalizeMilestoneVerificationVerdict } from '../verification/types'
import { getMilestoneVerifierMcpSession } from './milestone-session'

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
    instruction: {
      type: 'string',
      description: 'Concrete repair instruction for the worker agent.'
    },
    evidenceGap: {
      type: 'string',
      description: 'What milestone evidence is missing or insufficient.'
    },
    targetSliceId: {
      type: 'string',
      description: 'Slice to repair, e.g. m1-s2. Must belong to the current milestone.'
    },
    targetTaskId: {
      type: 'string',
      description: 'Specific task to repair, e.g. m1-s2-t1. Must belong to the current milestone.'
    }
  },
  required: ['instruction', 'evidenceGap'],
  anyOf: [{ required: ['targetSliceId'] }, { required: ['targetTaskId'] }]
} as const

const TOOLS = [
  {
    name: 'complete_milestone_verification',
    description:
      'Submit the final milestone verification verdict. When status is needs-repair, repairTasks is required; each item must include targetSliceId or targetTaskId from the prompt context.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['passed', 'needs-repair', 'blocked', 'inconclusive'],
          description: 'Milestone acceptance outcome.'
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low']
        },
        summary: { type: 'string' },
        requirementTrace: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              requirement: { type: 'string' },
              status: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } }
            },
            required: ['requirement', 'status']
          }
        },
        sliceAssessments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sliceId: { type: 'string' },
              status: { type: 'string' },
              reason: { type: 'string' }
            },
            required: ['sliceId', 'status']
          }
        },
        repairTasks: {
          type: 'array',
          description:
            'Required when status is needs-repair. Each repair must target an allowed sliceId or taskId.',
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
  if (!session) throw AppError.badRequest(`Milestone verifier session "${sessionId}" not found`)

  if (toolName !== 'complete_milestone_verification') {
    throw AppError.badRequest(`Unknown tool: "${toolName}"`)
  }

  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}

  const verdict = normalizeMilestoneVerificationVerdict(args, { milestoneId: session.milestoneId })
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

  if (request.id === undefined && method.startsWith('notifications/'))
    return { kind: 'notification' }

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
