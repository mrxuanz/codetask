import { DesignValidationError } from '../../shared.ts'
import { registeredPlanToExecutionTree } from '../domain/registered-plan-to-tree.ts'
import { validateTreeAgainstDraft } from '../domain/planning.ts'
import { validatePlanAbilityCodes } from './ability-validation.ts'
import {
  countPlanUnits,
  listMissingTaskContexts,
  normalizeRegisteredPlan,
  validatePlanOutlineCompleteness,
  validatePlanReferenceIds,
  validatePlanShape,
  validateRegisteredPlanDependencyGraph
} from './normalize.ts'
import { getPlannerMcpSession, type PlannerMcpSession } from './session.ts'
import { plannerMcpToolDefinitions } from './tools.ts'
import type { PlannerRegisteredTask, PlannerRegisteredTaskContext } from './types.ts'

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: {
    name?: string
    arguments?: unknown
    protocolVersion?: string
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

function badRequest(message: string, turnErrorCode?: string): never {
  const error = new DesignValidationError(message) as DesignValidationError & {
    turnErrorCode?: string
  }
  if (turnErrorCode) error.turnErrorCode = turnErrorCode
  throw error
}

function requireWritableSession(session: PlannerMcpSession): void {
  if (session.planCommitted) {
    badRequest('Plan session closed or stale run', 'plan.stale_run')
  }
}

function enqueuePlannerOperation<T>(
  session: PlannerMcpSession,
  operation: () => Promise<T>
): Promise<T> {
  const result = (session.operationQueue ?? Promise.resolve()).then(operation)
  session.operationQueue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function dispatchPlannerToolNow(
  session: PlannerMcpSession,
  toolName: string,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const args =
    argumentsValue && typeof argumentsValue === 'object'
      ? (argumentsValue as Record<string, unknown>)
      : {}

  switch (toolName) {
    case 'register_plan_outline':
      return registerPlanOutline(session, args)
    case 'register_task_context':
      return registerTaskContext(session, args)
    case 'update_task_context':
      return updateTaskContext(session, args)
    case 'finalize_plan':
      return requestPlanFinalization(session, args)
    default:
      badRequest(`Unknown tool: "${toolName}"`)
  }
}

/** Direct dispatcher for protocol unit tests; HTTP calls must use handlePlannerMcpJsonRpc. */
export async function dispatchPlannerToolForTests(
  sessionId: string,
  toolName: string,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const session = getPlannerMcpSession(sessionId)
  if (!session) {
    badRequest(`Plan session "${sessionId}" not found or already closed`)
  }
  return enqueuePlannerOperation(session, () =>
    dispatchPlannerToolNow(session, toolName, argumentsValue)
  )
}

async function dispatchWritablePlannerTool(
  sessionId: string,
  toolName: string,
  argumentsValue: unknown
): Promise<Record<string, unknown>> {
  const session = getPlannerMcpSession(sessionId)
  if (!session) {
    badRequest(`Plan session "${sessionId}" not found or already closed`)
  }
  return enqueuePlannerOperation(session, async () => {
    requireWritableSession(session)
    return dispatchPlannerToolNow(session, toolName, argumentsValue)
  })
}

function requirePlanMutable(session: PlannerMcpSession): void {
  if (session.finalizerPromise || session.planCommitting || session.planCommitted) {
    badRequest('plan finalization has started; the locked plan can no longer be modified')
  }
}

function taskCoordinates(args: Record<string, unknown>): {
  milestone: number
  slice: number
  task: number
  key: string
} {
  const milestone = Number(args.milestone)
  const slice = Number(args.slice)
  const task = Number(args.task)
  if (!Number.isInteger(milestone) || !Number.isInteger(slice) || !Number.isInteger(task)) {
    badRequest('milestone, slice, task must be integers ≥ 1')
  }
  if (milestone < 1 || slice < 1 || task < 1) {
    badRequest('milestone, slice, task must be integers ≥ 1')
  }
  return { milestone, slice, task, key: `m${milestone}-s${slice}-t${task}` }
}

function outlineTask(
  session: PlannerMcpSession,
  coordinates: ReturnType<typeof taskCoordinates>
): PlannerRegisteredTask {
  if (!session.planOutline) {
    badRequest(
      'plan outline is not registered; call register_plan_outline before registering task contexts'
    )
  }
  const task =
    session.planOutline.milestones[coordinates.milestone - 1]?.slices[coordinates.slice - 1]?.tasks[
      coordinates.task - 1
    ]
  if (!task) {
    badRequest(`task ${coordinates.key} does not exist in the locked plan outline`)
  }
  return task
}

function taskContextArgs(
  session: PlannerMcpSession,
  args: Record<string, unknown>
): {
  key: string
  context: PlannerRegisteredTaskContext
} {
  const coordinates = taskCoordinates(args)
  const expected = outlineTask(session, coordinates)
  const taskTitle = typeof args.taskTitle === 'string' ? args.taskTitle.trim() : ''
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  if (!taskTitle || !content) {
    badRequest('taskTitle and content are required')
  }
  if (taskTitle !== expected.title?.trim()) {
    badRequest(
      `taskTitle mismatch for ${coordinates.key}; expected "${expected.title}", received "${taskTitle}"`
    )
  }
  return { key: coordinates.key, context: { taskTitle, content } }
}

async function registerTaskContext(
  session: PlannerMcpSession,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requirePlanMutable(session)
  const { key, context } = taskContextArgs(session, args)
  const existing = session.taskContexts.get(key)
  if (existing) {
    if (existing.taskTitle === context.taskTitle && existing.content === context.content) {
      return toolTextResult(`Task context ${key} was already registered with identical content`)
    }
    badRequest(`task context ${key} is already registered; use update_task_context to revise it`)
  }

  session.taskContexts.set(key, context)
  try {
    await session.onTaskContextRegistered?.(key, session.taskContexts.size)
  } catch (error) {
    session.taskContexts.delete(key)
    throw error
  }

  return toolTextResult(
    `Registered ${key} (${context.content.length} chars); ${session.taskContexts.size} task context(s) complete`
  )
}

async function updateTaskContext(
  session: PlannerMcpSession,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requirePlanMutable(session)
  const { key, context } = taskContextArgs(session, args)
  const existing = session.taskContexts.get(key)
  if (!existing) {
    badRequest(`Task context ${key} is not registered yet; call register_task_context first`)
  }
  if (existing.taskTitle === context.taskTitle && existing.content === context.content) {
    return toolTextResult(`Task context ${key} already has identical content`)
  }

  session.taskContexts.set(key, context)
  try {
    await session.onTaskContextRegistered?.(key, session.taskContexts.size)
  } catch (error) {
    session.taskContexts.set(key, existing)
    throw error
  }
  return toolTextResult(`Updated ${key} (${context.content.length} chars)`)
}

async function registerPlanOutline(
  session: PlannerMcpSession,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requirePlanMutable(session)

  const plan = normalizeRegisteredPlan(args)
  const counts = countPlanUnits(plan)

  validatePlanShape(plan)
  validatePlanOutlineCompleteness(plan)
  validateRegisteredPlanDependencyGraph(plan)
  validatePlanAbilityCodes(plan, session.allowedAbilityCodes)

  try {
    validatePlanReferenceIds(plan, session.validReferenceIds)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reference validation failed'
    badRequest(message, 'draft.reference_invalid')
  }

  if (session.planOutline) {
    if (JSON.stringify(session.planOutline) === JSON.stringify(plan)) {
      return toolTextResult(
        `Plan outline was already registered with identical content (${counts.tasks} tasks)`
      )
    }
    badRequest('plan outline is already locked and cannot be replaced during this planning run')
  }

  session.planOutline = plan
  try {
    await session.onPlanOutlineRegistered?.(counts)
  } catch (error) {
    session.planOutline = null
    throw error
  }

  return toolTextResult(
    `Plan outline locked (${counts.milestones} milestones, ${counts.slices} slices, ${counts.tasks} tasks). Fill every task context, then call finalize_plan.`
  )
}

function requestPlanFinalization(
  session: PlannerMcpSession,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (Object.keys(args).length > 0) {
    badRequest('finalize_plan does not accept arguments')
  }
  if (!session.planOutline) {
    badRequest('plan outline is not registered; call register_plan_outline first')
  }
  const missing = listMissingTaskContexts(session.planOutline, session.taskContexts)
  if (missing.length > 0) {
    badRequest(
      `cannot finalize plan; missing task context for ${missing.length} task(s): ${missing.join(', ')}`
    )
  }
  const counts = countPlanUnits(session.planOutline)
  if (!session.finalizerPromise) {
    session.finalizerPromise = finalizePlan(session, counts)
  }
  return toolTextResult(
    `Plan accepted for finalization (${counts.milestones} milestones, ${counts.slices} slices, ${counts.tasks} tasks)`
  )
}

async function finalizePlan(
  session: PlannerMcpSession,
  counts: { milestones: number; slices: number; tasks: number }
): Promise<void> {
  try {
    if (session.planCommitted || session.planCommitting) {
      return
    }
    session.planCommitting = true

    const tree = registeredPlanToExecutionTree({
      planningSessionId: session.planningSessionId,
      plan: session.planOutline!,
      contexts: session.taskContexts,
      defaultCoreCode: session.defaultCoreCode
    })

    validateTreeAgainstDraft({
      tree,
      abilities: session.draftSnapshot.abilities,
      references: session.draftSnapshot.references,
      manifest: session.referenceManifest
    })

    await session.planning.commitExecutionTree({
      sessionId: session.planningSessionId,
      fencingToken: session.fencingToken,
      tree
    })

    session.planCommitted = true
    session.abortTurn?.()
    void counts
  } catch (error) {
    session.finalizerError = error instanceof Error ? error : new Error(String(error))
    session.planCommitting = false
  }
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
      request.params && typeof request.params.protocolVersion === 'string'
        ? request.params.protocolVersion
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
    const value = await dispatchWritablePlannerTool(sessionId, toolName, toolArguments)
    return jsonRpcOk(id, value)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP tool failed'
    const turnErrorCode =
      error && typeof error === 'object' && 'turnErrorCode' in error
        ? (error as { turnErrorCode?: string }).turnErrorCode
        : undefined
    if (turnErrorCode) {
      return jsonRpcError(id, -32000, message, { turnErrorCode })
    }
    return jsonRpcError(id, -32000, message)
  }
}
