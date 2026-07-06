import { AppError } from '../../error'
import { plannerSandboxDebug } from '../../debug/planner-sandbox'
import type { PlannerRegisteredTaskContext } from '../plan-types'
import {
  countPlanUnits,
  listMissingTaskContexts,
  normalizeRegisteredPlan,
  validatePlanReferenceIds,
  validatePlanShape,
  validateRegisteredPlanDependencyGraph
} from './normalize'
import { validatePlanAbilityCodes } from '../plan-ability-validation'
import { plannerMcpToolDefinitions } from './tools'
import { getPlannerMcpSession } from './session'

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

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>
): McpDispatchResult {
  return {
    kind: 'json',
    body: {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        ...(data ? { data } : {})
      }
    }
  }
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
  const session = getPlannerMcpSession(sessionId)
  if (!session) {
    throw AppError.badRequest(`Plan session "${sessionId}" not found or already closed`)
  }

  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}

  switch (toolName) {
    case 'register_task_context':
      return registerTaskContext(session, args)
    case 'update_task_context':
      return updateTaskContext(session, args)
    case 'register_plan':
      return registerPlan(session, args)
    default:
      throw AppError.badRequest(`Unknown tool: "${toolName}"`)
  }
}

function registerTaskContext(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  args: Record<string, unknown>
): Record<string, unknown> {
  const milestone = Number(args.milestone)
  const slice = Number(args.slice)
  const task = Number(args.task)
  if (!Number.isInteger(milestone) || !Number.isInteger(slice) || !Number.isInteger(task)) {
    throw AppError.badRequest('milestone, slice, task must be integers ≥ 1')
  }
  if (milestone < 1 || slice < 1 || task < 1) {
    throw AppError.badRequest('milestone, slice, task must be integers ≥ 1')
  }

  const taskTitle = typeof args.taskTitle === 'string' ? args.taskTitle.trim() : ''
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  if (!taskTitle || !content) {
    throw AppError.badRequest('taskTitle and content are required')
  }

  const key = `m${milestone}-s${slice}-t${task}`
  const context: PlannerRegisteredTaskContext = { taskTitle, content }
  session.taskContexts.set(key, context)

  const done = session.taskContexts.size
  session.onTaskContextRegistered?.(key, done)

  plannerSandboxDebug('planner-mcp: register_task_context ok', {
    jobId: session.jobId,
    key,
    taskTitle,
    contentChars: content.length,
    contextsRegistered: done
  })

  return toolTextResult(`Registered ${key} (${content.length} chars)`)
}

function updateTaskContext(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  args: Record<string, unknown>
): Record<string, unknown> {
  const milestone = Number(args.milestone)
  const slice = Number(args.slice)
  const task = Number(args.task)
  if (!Number.isInteger(milestone) || !Number.isInteger(slice) || !Number.isInteger(task)) {
    throw AppError.badRequest('milestone, slice, task must be integers ≥ 1')
  }
  if (milestone < 1 || slice < 1 || task < 1) {
    throw AppError.badRequest('milestone, slice, task must be integers ≥ 1')
  }

  const key = `m${milestone}-s${slice}-t${task}`
  if (!session.taskContexts.has(key)) {
    throw AppError.badRequest(
      `Task context ${key} is not registered yet; call register_task_context first`
    )
  }

  const taskTitle = typeof args.taskTitle === 'string' ? args.taskTitle.trim() : ''
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  if (!taskTitle || !content) {
    throw AppError.badRequest('taskTitle and content are required')
  }

  session.taskContexts.set(key, { taskTitle, content })
  session.onTaskContextRegistered?.(key, session.taskContexts.size)
  plannerSandboxDebug('planner-mcp: update_task_context ok', {
    jobId: session.jobId,
    key,
    taskTitle,
    contentChars: content.length,
    contextsRegistered: session.taskContexts.size
  })
  return toolTextResult(`Updated ${key} (${content.length} chars)`)
}

function registerPlan(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  args: Record<string, unknown>
): Record<string, unknown> {
  plannerSandboxDebug('planner-mcp: register_plan begin', {
    jobId: session.jobId,
    contextsRegistered: session.taskContexts.size,
    contextKeys: [...session.taskContexts.keys()],
    allowedAbilityCodes: session.allowedAbilityCodes
  })

  let plan
  try {
    plan = normalizeRegisteredPlan(args)
  } catch (error) {
    plannerSandboxDebug('planner-mcp: register_plan rejected (normalize)', {
      jobId: session.jobId,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  const counts = countPlanUnits(plan)
  plannerSandboxDebug('planner-mcp: register_plan normalized', {
    jobId: session.jobId,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks
  })

  const missing = listMissingTaskContexts(plan, session.taskContexts)
  if (missing.length > 0) {
    plannerSandboxDebug('planner-mcp: register_plan rejected (missing contexts)', {
      jobId: session.jobId,
      missing,
      contextsRegistered: session.taskContexts.size
    })
    throw AppError.badRequest(
      `missing task context for ${missing.length} task(s): ${missing.join(', ')}`
    )
  }

  try {
    validatePlanShape(plan)
    validateRegisteredPlanDependencyGraph(plan)
    validatePlanAbilityCodes(plan, session.allowedAbilityCodes)
  } catch (error) {
    plannerSandboxDebug('planner-mcp: register_plan rejected (validation)', {
      jobId: session.jobId,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  try {
    validatePlanReferenceIds(plan, session.validReferenceIds, session.referenceManifest)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reference validation failed'
    plannerSandboxDebug('planner-mcp: register_plan rejected (references)', {
      jobId: session.jobId,
      error: message
    })
    throw AppError.badRequest(message, 'draft.reference_invalid')
  }

  session.registeredPlan = plan
  session.onPlanRegistered?.(counts)

  plannerSandboxDebug('planner-mcp: register_plan ok', {
    jobId: session.jobId,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks
  })

  return toolTextResult(
    `Registered structured plan (${counts.milestones} milestones, ${counts.slices} slices, ${counts.tasks} tasks)`
  )
}

export async function handlePlannerMcpJsonRpc(
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
    const clientProtocol =
      request.params &&
      typeof request.params === 'object' &&
      typeof (request.params as { protocolVersion?: string }).protocolVersion === 'string'
        ? (request.params as { protocolVersion: string }).protocolVersion
        : '2024-11-05'
    return jsonRpcOk(id, {
      protocolVersion: clientProtocol,
      capabilities: { tools: {} },
      serverInfo: { name: 'codetask-planner', version: '1.0.0' }
    })
  }

  if (method === 'tools/list') {
    return jsonRpcOk(id, { tools: plannerMcpToolDefinitions() })
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
    plannerSandboxDebug('planner-mcp: tool call failed', {
      sessionId,
      toolName,
      error: message
    })
    if (error instanceof AppError && typeof error.data.turnErrorCode === 'string') {
      return jsonRpcError(id, -32000, message, {
        turnErrorCode: error.data.turnErrorCode,
        ...(error.data.turnErrorParams ? { turnErrorParams: error.data.turnErrorParams } : {})
      })
    }
    return jsonRpcError(id, -32000, message)
  }
}
