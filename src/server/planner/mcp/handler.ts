import { AppError } from '../../error'
import { plannerSandboxDebug } from '../../debug/planner-sandbox'
import type { PlannerRegisteredTask, PlannerRegisteredTaskContext } from '../plan-types'
import {
  countPlanUnits,
  listMissingTaskContexts,
  normalizeRegisteredPlan,
  validatePlanOutlineCompleteness,
  validatePlanReferenceIds,
  validatePlanShape,
  validateRegisteredPlanDependencyGraph
} from './normalize'
import { validatePlanAbilityCodes } from '../plan-ability-validation'
import { plannerMcpToolDefinitions } from './tools'
import { getPlannerMcpSession } from './session'
import { assertRunWritable } from '../../legacy-control-plane/workload-slot-store'

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

async function requireWritableRun(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>
): Promise<void> {
  if (!(await assertRunWritable(session.ownerKind, session.ownerId, session.runId))) {
    throw AppError.badRequest('Plan session closed or stale run', 'plan.stale_run')
  }
}

function enqueuePlannerOperation<T>(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
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
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
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
      throw AppError.badRequest(`Unknown tool: "${toolName}"`)
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
    throw AppError.badRequest(`Plan session "${sessionId}" not found or already closed`)
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
    throw AppError.badRequest(`Plan session "${sessionId}" not found or already closed`)
  }
  return enqueuePlannerOperation(session, async () => {
    await requireWritableRun(session)
    return dispatchPlannerToolNow(session, toolName, argumentsValue)
  })
}

function requirePlanMutable(session: NonNullable<ReturnType<typeof getPlannerMcpSession>>): void {
  if (session.finalizerPromise || session.planCommitting || session.planCommitted) {
    throw AppError.badRequest(
      'plan finalization has started; the locked plan can no longer be modified'
    )
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
    throw AppError.badRequest('milestone, slice, task must be integers ≥ 1')
  }
  if (milestone < 1 || slice < 1 || task < 1) {
    throw AppError.badRequest('milestone, slice, task must be integers ≥ 1')
  }
  return { milestone, slice, task, key: `m${milestone}-s${slice}-t${task}` }
}

function outlineTask(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  coordinates: ReturnType<typeof taskCoordinates>
): PlannerRegisteredTask {
  if (!session.planOutline) {
    throw AppError.badRequest(
      'plan outline is not registered; call register_plan_outline before registering task contexts'
    )
  }
  const task =
    session.planOutline.milestones[coordinates.milestone - 1]?.slices[coordinates.slice - 1]?.tasks[
      coordinates.task - 1
    ]
  if (!task) {
    throw AppError.badRequest(`task ${coordinates.key} does not exist in the locked plan outline`)
  }
  return task
}

function taskContextArgs(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
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
    throw AppError.badRequest('taskTitle and content are required')
  }
  if (taskTitle !== expected.title?.trim()) {
    throw AppError.badRequest(
      `taskTitle mismatch for ${coordinates.key}; expected "${expected.title}", received "${taskTitle}"`
    )
  }
  return { key: coordinates.key, context: { taskTitle, content } }
}

async function registerTaskContext(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requirePlanMutable(session)
  const { key, context } = taskContextArgs(session, args)
  const existing = session.taskContexts.get(key)
  if (existing) {
    if (existing.taskTitle === context.taskTitle && existing.content === context.content) {
      return toolTextResult(`Task context ${key} was already registered with identical content`)
    }
    throw AppError.badRequest(
      `task context ${key} is already registered; use update_task_context to revise it`
    )
  }

  session.taskContexts.set(key, context)
  try {
    await session.onTaskContextRegistered?.(key, session.taskContexts.size)
  } catch (error) {
    session.taskContexts.delete(key)
    throw error
  }

  plannerSandboxDebug('planner-mcp: register_task_context ok', {
    jobId: session.jobId,
    runId: session.runId,
    key,
    taskTitle: context.taskTitle,
    contentChars: context.content.length,
    contextsRegistered: session.taskContexts.size
  })

  return toolTextResult(
    `Registered ${key} (${context.content.length} chars); ${session.taskContexts.size} task context(s) complete`
  )
}

async function updateTaskContext(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requirePlanMutable(session)
  const { key, context } = taskContextArgs(session, args)
  const existing = session.taskContexts.get(key)
  if (!existing) {
    throw AppError.badRequest(
      `Task context ${key} is not registered yet; call register_task_context first`
    )
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
  plannerSandboxDebug('planner-mcp: update_task_context ok', {
    jobId: session.jobId,
    runId: session.runId,
    key,
    taskTitle: context.taskTitle,
    contentChars: context.content.length,
    contextsRegistered: session.taskContexts.size
  })
  return toolTextResult(`Updated ${key} (${context.content.length} chars)`)
}

async function registerPlanOutline(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  requirePlanMutable(session)
  plannerSandboxDebug('planner-mcp: register_plan_outline begin', {
    jobId: session.jobId,
    runId: session.runId,
    contextsRegistered: session.taskContexts.size,
    contextKeys: [...session.taskContexts.keys()],
    allowedAbilityCodes: session.allowedAbilityCodes
  })

  let plan
  try {
    plan = normalizeRegisteredPlan(args)
  } catch (error) {
    plannerSandboxDebug('planner-mcp: register_plan_outline rejected (normalize)', {
      jobId: session.jobId,
      runId: session.runId,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  const counts = countPlanUnits(plan)
  plannerSandboxDebug('planner-mcp: register_plan_outline normalized', {
    jobId: session.jobId,
    runId: session.runId,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks
  })

  try {
    validatePlanShape(plan)
    validatePlanOutlineCompleteness(plan)
    validateRegisteredPlanDependencyGraph(plan)
    validatePlanAbilityCodes(plan, session.allowedAbilityCodes)
  } catch (error) {
    plannerSandboxDebug('planner-mcp: register_plan_outline rejected (validation)', {
      jobId: session.jobId,
      runId: session.runId,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  try {
    validatePlanReferenceIds(plan, session.validReferenceIds, session.referenceManifest)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reference validation failed'
    plannerSandboxDebug('planner-mcp: register_plan_outline rejected (references)', {
      jobId: session.jobId,
      runId: session.runId,
      error: message
    })
    throw AppError.badRequest(message, 'draft.reference_invalid')
  }

  if (session.planOutline) {
    if (JSON.stringify(session.planOutline) === JSON.stringify(plan)) {
      return toolTextResult(
        `Plan outline was already registered with identical content (${counts.tasks} tasks)`
      )
    }
    throw AppError.badRequest(
      'plan outline is already locked and cannot be replaced during this planning run'
    )
  }

  session.planOutline = plan
  try {
    await session.onPlanOutlineRegistered?.(counts)
  } catch (error) {
    session.planOutline = null
    throw error
  }

  plannerSandboxDebug('planner-mcp: register_plan_outline accepted', {
    jobId: session.jobId,
    runId: session.runId,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks
  })

  return toolTextResult(
    `Plan outline locked (${counts.milestones} milestones, ${counts.slices} slices, ${counts.tasks} tasks). Fill every task context, then call finalize_plan.`
  )
}

function requestPlanFinalization(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (Object.keys(args).length > 0) {
    throw AppError.badRequest('finalize_plan does not accept arguments')
  }
  if (!session.planOutline) {
    throw AppError.badRequest('plan outline is not registered; call register_plan_outline first')
  }
  const missing = listMissingTaskContexts(session.planOutline, session.taskContexts)
  if (missing.length > 0) {
    throw AppError.badRequest(
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
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  counts: { milestones: number; slices: number; tasks: number }
): Promise<void> {
  try {
    if (!(await assertRunWritable(session.ownerKind, session.ownerId, session.runId))) {
      const activeRun = await import('../../legacy-control-plane/workload-slot-store').then((m) =>
        m.getActiveRun(session.ownerKind, session.ownerId)
      )
      logStructured('planner.finalizer.stale', {
        runId: session.runId,
        ownerKind: session.ownerKind,
        ownerId: session.ownerId,
        reason: 'run_no_longer_active',
        currentRunId: activeRun?.runId ?? null
      })
      return
    }

    if (session.planCommitted || session.planCommitting) {
      return
    }
    session.planCommitting = true

    const commitOk = await invokePlanCommit(session, counts)
    if (!commitOk) {
      const stillActive = await assertRunWritable(session.ownerKind, session.ownerId, session.runId)
      const activeRun = await import('../../legacy-control-plane/workload-slot-store').then((m) =>
        m.getActiveRun(session.ownerKind, session.ownerId)
      )
      logStructured('planner.finalizer.rejected', {
        runId: session.runId,
        ownerId: session.ownerId,
        reason: stillActive ? 'fenced_update_failed' : 'run_no_longer_active',
        currentRunId: activeRun?.runId ?? null
      })
      return
    }

    session.planCommitted = true
    session.abortTurn?.()

    logStructured('planner.finalizer.committed', {
      runId: session.runId,
      ownerId: session.ownerId,
      milestones: counts.milestones,
      slices: counts.slices,
      tasks: counts.tasks
    })
  } catch (error) {
    session.finalizerError = error instanceof Error ? error : new Error(String(error))
    session.planCommitting = false
    logStructured('planner.finalizer.failed', {
      runId: session.runId,
      ownerId: session.ownerId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function invokePlanCommit(
  session: NonNullable<ReturnType<typeof getPlannerMcpSession>>,
  counts: { milestones: number; slices: number; tasks: number }
): Promise<boolean> {
  const { flattenRegisteredPlan } = await import('../save-plan')
  const saved = flattenRegisteredPlan(session.planOutline!, session.taskContexts)

  // Single commit path for all thread_job planning (design_session ownerKind is legacy-only).
  const { commitDesignPlanReady } = await import('../../design-session/planner')
  return commitDesignPlanReady(
    session.ownerId,
    session.runId,
    saved,
    counts,
    session.phaseAdvance,
    {
      planRevision: session.planRevision,
      clearConfirmed: session.clearConfirmed
    }
  )
}

function logStructured(step: string, detail: Record<string, unknown>): void {
  plannerSandboxDebug(step, detail)
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
    const value = await dispatchWritablePlannerTool(sessionId, toolName, toolArguments)
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
