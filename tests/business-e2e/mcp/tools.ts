import type { PublicApiClient } from '../api/client'
import * as ops from '../api/operations'
import type { CapabilityStore } from './capabilities'
import type { OperationLedger } from '../reports/ledger'

export type ToolResult = {
  ok: boolean
  content: unknown
  error?: string
}

export type ToolContext = {
  capabilityId: string
  client: PublicApiClient
  capabilities: CapabilityStore
  ledger: OperationLedger
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

function ok(content: unknown): ToolResult {
  return { ok: true, content }
}

function fail(error: string): ToolResult {
  return { ok: false, content: { error }, error }
}

function normalizeArtifacts(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown
    } catch {
      return { raw: value }
    }
  }
  return value
}

export const TOOL_DEFS: Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}> = [
  {
    name: 'codetask_create_project',
    description: 'Create a CodeTask project bound to a workspace root',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceRoot: { type: 'string' },
        title: { type: 'string' }
      },
      required: ['workspaceRoot']
    }
  },
  {
    name: 'codetask_create_thread',
    description: 'Create a chat or create_task thread in a project',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string' },
        coreCode: { type: 'string' },
        threadKind: { type: 'string' }
      },
      required: ['projectId']
    }
  },
  {
    name: 'codetask_get_thread',
    description: 'Get thread details',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId']
    }
  },
  {
    name: 'codetask_list_cores',
    description: 'List available conversation cores',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'codetask_start_turn',
    description: 'Start a conversation turn with a user message',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        message: { type: 'string' },
        kind: { type: 'string' },
        createTaskMode: { type: 'boolean' }
      },
      required: ['threadId', 'message']
    }
  },
  {
    name: 'codetask_get_turn',
    description: 'Get turn status',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        turnId: { type: 'string' }
      },
      required: ['threadId', 'turnId']
    }
  },
  {
    name: 'codetask_wait_turn',
    description: 'Poll until turn reaches a terminal status',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        turnId: { type: 'string' },
        timeoutMs: { type: 'number' }
      },
      required: ['threadId', 'turnId']
    }
  },
  {
    name: 'codetask_list_messages',
    description: 'List thread messages',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId']
    }
  },
  {
    name: 'codetask_cancel_turn',
    description: 'Cancel an in-flight turn',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        turnId: { type: 'string' }
      },
      required: ['threadId', 'turnId']
    }
  },
  {
    name: 'case_next_fixture',
    description: 'Unlock the next staged fixture phase for this case (R10)',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string' }
      }
    }
  },
  {
    name: 'codetask_get_thread_drafts',
    description: 'List drafts for a thread',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId']
    }
  },
  {
    name: 'codetask_confirm_draft',
    description: 'Confirm a draft message',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' }
      },
      required: ['threadId', 'messageId']
    }
  },
  {
    name: 'codetask_confirm_draft_final',
    description: 'Final-confirm a draft and enter planning',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' }
      },
      required: ['threadId', 'messageId']
    }
  },
  {
    name: 'codetask_get_latest_job',
    description: 'Get the latest job for a thread',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId']
    }
  },
  {
    name: 'codetask_get_plans',
    description: 'Alias of get latest job/plan payload for a thread',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string' } },
      required: ['threadId']
    }
  },
  {
    name: 'codetask_confirm_plan',
    description: 'Confirm the plan for a job',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        jobId: { type: 'string' }
      },
      required: ['threadId', 'jobId']
    }
  },
  {
    name: 'codetask_confirm_plan_node',
    description: 'Confirm a single plan node',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        jobId: { type: 'string' },
        nodeRef: { type: 'string' }
      },
      required: ['threadId', 'jobId', 'nodeRef']
    }
  },
  {
    name: 'codetask_create_job',
    description: 'Create a job from a draft',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        draftMessageId: { type: 'string' }
      },
      required: ['threadId']
    }
  },
  {
    name: 'codetask_get_job',
    description: 'Get job details',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        jobId: { type: 'string' }
      },
      required: ['threadId', 'jobId']
    }
  },
  {
    name: 'codetask_wait_job',
    description: 'Poll until job reaches a terminal status',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        jobId: { type: 'string' },
        timeoutMs: { type: 'number' }
      },
      required: ['threadId', 'jobId']
    }
  },
  {
    name: 'codetask_get_task_evidence',
    description: 'Get task evidence for a job task',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        jobId: { type: 'string' },
        taskId: { type: 'string' }
      },
      required: ['threadId', 'jobId', 'taskId']
    }
  },
  {
    name: 'codetask_update_draft',
    description: 'Patch draft content fields',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' },
        patch: { type: 'object' }
      },
      required: ['threadId', 'messageId', 'patch']
    }
  },
  {
    name: 'codetask_unlock_draft',
    description: 'Unlock a draft for edit',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' }
      },
      required: ['threadId', 'messageId']
    }
  },
  {
    name: 'codetask_unlock_draft_contract',
    description: 'Unlock requirements contract for edit',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' }
      },
      required: ['threadId', 'messageId']
    }
  },
  {
    name: 'codetask_confirm_draft_section',
    description: 'Confirm a single draft section',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' },
        section: { type: 'string' }
      },
      required: ['threadId', 'messageId', 'section']
    }
  },
  {
    name: 'codetask_update_ability_providers',
    description: 'Update draft ability provider selections',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        messageId: { type: 'string' },
        selections: { type: 'array' }
      },
      required: ['threadId', 'messageId', 'selections']
    }
  },
  {
    name: 'codetask_upload_attachment',
    description: 'Upload a file attachment to a thread',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string' },
        filePath: { type: 'string' },
        fileName: { type: 'string' }
      },
      required: ['threadId', 'filePath', 'fileName']
    }
  },
  {
    name: 'codetask_soft_request',
    description: 'Soft HTTP probe that returns status without throwing',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        path: { type: 'string' },
        body: {},
        operationId: { type: 'string' }
      },
      required: ['method', 'path']
    }
  },
  {
    name: 'codetask_pause_job',
    description: 'Pause a running job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId']
    }
  },
  {
    name: 'codetask_resume_job',
    description: 'Resume a paused job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId']
    }
  },
  {
    name: 'codetask_continue_job',
    description: 'Continue a recoverable job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId']
    }
  },
  {
    name: 'codetask_cancel_job',
    description: 'Cancel a job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId']
    }
  },
  {
    name: 'codetask_restart_job',
    description: 'Restart a terminal job',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId']
    }
  },
  {
    name: 'case_checkpoint',
    description: 'Record a named checkpoint for the current case',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        detail: {}
      },
      required: ['name']
    }
  },
  {
    name: 'report_case_result',
    description: 'Submit the case result exactly once',
    inputSchema: {
      type: 'object',
      properties: {
        caseId: { type: 'string' },
        status: { type: 'string' },
        summary: { type: 'string' },
        observations: {},
        artifacts: {}
      },
      required: ['caseId', 'status', 'summary']
    }
  }
]

const handlers: Record<string, ToolHandler> = {
  async codetask_create_project(args, ctx) {
    const workspaceRoot =
      typeof args.workspaceRoot === 'string' ? args.workspaceRoot : ctx.capabilities.get(ctx.capabilityId)?.workspaceRoot
    if (!workspaceRoot) return fail('workspaceRoot required')
    const project = await ops.createProject(ctx.client, {
      workspaceRoot,
      title: typeof args.title === 'string' ? args.title : 'business-e2e'
    })
    return ok(project)
  },
  async codetask_create_thread(args, ctx) {
    const projectId = String(args.projectId ?? '')
    const thread = await ops.createThread(ctx.client, projectId, {
      title: typeof args.title === 'string' ? args.title : undefined,
      coreCode: typeof args.coreCode === 'string' ? args.coreCode : 'opencode',
      threadKind: typeof args.threadKind === 'string' ? args.threadKind : 'chat'
    })
    return ok(thread)
  },
  async codetask_get_thread(args, ctx) {
    return ok(await ops.getThread(ctx.client, String(args.threadId)))
  },
  async codetask_list_cores(_args, ctx) {
    return ok(await ops.listCores(ctx.client))
  },
  async codetask_start_turn(args, ctx) {
    const threadId = String(args.threadId)
    const thread = await ops.getThread(ctx.client, threadId)
    const threadKind = String(thread.threadKind ?? 'chat')
    const createTaskMode =
      args.createTaskMode === true ||
      threadKind === 'create_task' ||
      args.kind === 'create_task' ||
      args.kind === 'draft'
    const kind =
      typeof args.kind === 'string'
        ? args.kind
        : createTaskMode
          ? 'create_task'
          : 'chat'
    return ok(
      await ops.startTurn(ctx.client, threadId, String(args.message), {
        createTaskMode,
        kind
      })
    )
  },
  async codetask_get_turn(args, ctx) {
    return ok(await ops.getTurn(ctx.client, String(args.threadId), String(args.turnId)))
  },
  async codetask_wait_turn(args, ctx) {
    const turn = await ops.waitTurnTerminal(
      ctx.client,
      String(args.threadId),
      String(args.turnId),
      typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
    )
    return ok(turn)
  },
  async codetask_list_messages(args, ctx) {
    return ok(await ops.listMessages(ctx.client, String(args.threadId)))
  },
  async codetask_cancel_turn(args, ctx) {
    return ok(await ops.cancelTurn(ctx.client, String(args.threadId), String(args.turnId)))
  },
  async case_next_fixture(args, ctx) {
    const capability = ctx.capabilities.assertAllowed(ctx.capabilityId, 'case_next_fixture')
    const state = capability.fixtureState
    if (!state) return fail('fixture_state_missing')
    if (state.nextIndex >= state.phaseOrder.length) {
      return fail('fixture_phases_exhausted')
    }
    const requested = typeof args.phase === 'string' ? args.phase : undefined
    const expected = state.phaseOrder[state.nextIndex]
    if (requested && requested !== expected) {
      return fail(`fixture_phase_out_of_order:expected_${expected}:got_${requested}`)
    }
    const phaseName = expected
    const payload = state.phases[phaseName] ?? {}
    state.unlocked.push(phaseName)
    state.nextIndex += 1
    ctx.ledger.record({
      caseRunId: capability.caseRunId,
      operationId: 'case.next_fixture',
      transport: 'mcp',
      routeOrTool: 'case_next_fixture',
      ok: true,
      detail: { phase: phaseName, unlocked: [...state.unlocked] }
    })
    return ok({
      phase: phaseName,
      unlocked: [...state.unlocked],
      remaining: state.phaseOrder.slice(state.nextIndex),
      payload
    })
  },
  async codetask_get_thread_drafts(args, ctx) {
    return ok(await ops.listThreadDrafts(ctx.client, String(args.threadId)))
  },
  async codetask_confirm_draft(args, ctx) {
    return ok(
      await ops.confirmDraft(ctx.client, String(args.threadId), String(args.messageId))
    )
  },
  async codetask_confirm_draft_final(args, ctx) {
    return ok(
      await ops.confirmDraftFinal(ctx.client, String(args.threadId), String(args.messageId))
    )
  },
  async codetask_get_latest_job(args, ctx) {
    return ok(await ops.getLatestJob(ctx.client, String(args.threadId)))
  },
  async codetask_get_plans(args, ctx) {
    return ok(await ops.getLatestJob(ctx.client, String(args.threadId)))
  },
  async codetask_confirm_plan(args, ctx) {
    return ok(
      await ops.confirmPlan(ctx.client, String(args.threadId), String(args.jobId))
    )
  },
  async codetask_confirm_plan_node(args, ctx) {
    return ok(
      await ops.confirmPlanNode(
        ctx.client,
        String(args.threadId),
        String(args.jobId),
        String(args.nodeRef)
      )
    )
  },
  async codetask_create_job(args, ctx) {
    const body: Record<string, unknown> = {}
    if (typeof args.draftMessageId === 'string') body.draftMessageId = args.draftMessageId
    return ok(await ops.createJob(ctx.client, String(args.threadId), body))
  },
  async codetask_get_job(args, ctx) {
    return ok(await ops.getJob(ctx.client, String(args.threadId), String(args.jobId)))
  },
  async codetask_wait_job(args, ctx) {
    return ok(
      await ops.waitJobTerminal(
        ctx.client,
        String(args.threadId),
        String(args.jobId),
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
      )
    )
  },
  async codetask_get_task_evidence(args, ctx) {
    return ok(
      await ops.getTaskEvidence(
        ctx.client,
        String(args.threadId),
        String(args.jobId),
        String(args.taskId)
      )
    )
  },
  async codetask_update_draft(args, ctx) {
    return ok(
      await ops.updateDraft(
        ctx.client,
        String(args.threadId),
        String(args.messageId),
        (args.patch as Record<string, unknown>) ?? {}
      )
    )
  },
  async codetask_unlock_draft(args, ctx) {
    return ok(await ops.unlockDraft(ctx.client, String(args.threadId), String(args.messageId)))
  },
  async codetask_unlock_draft_contract(args, ctx) {
    return ok(
      await ops.unlockDraftContract(ctx.client, String(args.threadId), String(args.messageId))
    )
  },
  async codetask_confirm_draft_section(args, ctx) {
    return ok(
      await ops.confirmDraftSection(
        ctx.client,
        String(args.threadId),
        String(args.messageId),
        String(args.section)
      )
    )
  },
  async codetask_update_ability_providers(args, ctx) {
    const selections = Array.isArray(args.selections)
      ? (args.selections as Array<{ abilityCode: string; coreCode: string }>)
      : []
    return ok(
      await ops.updateDraftAbilities(
        ctx.client,
        String(args.threadId),
        String(args.messageId),
        selections
      )
    )
  },
  async codetask_upload_attachment(args, ctx) {
    return ok(
      await ops.uploadThreadAttachment(
        ctx.client,
        String(args.threadId),
        String(args.filePath),
        String(args.fileName)
      )
    )
  },
  async codetask_soft_request(args, ctx) {
    return ok(
      await ops.softRequest(
        ctx.client,
        String(args.method ?? 'GET'),
        String(args.path),
        args.body,
        typeof args.operationId === 'string' ? args.operationId : undefined
      )
    )
  },
  async codetask_pause_job(args, ctx) {
    return ok(await ops.pauseJob(ctx.client, String(args.jobId)))
  },
  async codetask_resume_job(args, ctx) {
    return ok(await ops.resumeJob(ctx.client, String(args.jobId)))
  },
  async codetask_continue_job(args, ctx) {
    return ok(await ops.continueJob(ctx.client, String(args.jobId)))
  },
  async codetask_cancel_job(args, ctx) {
    return ok(await ops.cancelJob(ctx.client, String(args.jobId)))
  },
  async codetask_restart_job(args, ctx) {
    return ok(await ops.restartJob(ctx.client, String(args.jobId)))
  },
  async case_checkpoint(args, ctx) {
    const capability = ctx.capabilities.assertAllowed(ctx.capabilityId, 'case_checkpoint')
    const name = String(args.name)
    capability.checkpoints.push(name)
    ctx.ledger.record({
      caseRunId: capability.caseRunId,
      operationId: 'case.checkpoint',
      transport: 'mcp',
      routeOrTool: 'case_checkpoint',
      ok: true,
      detail: { name, detail: args.detail }
    })
    return ok({ checkpoints: capability.checkpoints })
  },
  async report_case_result(args, ctx) {
    const capability = ctx.capabilities.assertAllowed(ctx.capabilityId, 'report_case_result')
    if (capability.agentReport) return fail('report_case_result already submitted')
    capability.agentReport = {
      caseId: String(args.caseId),
      status: String(args.status),
      summary: String(args.summary),
      observations: args.observations,
      artifacts: normalizeArtifacts(args.artifacts)
    }
    ctx.ledger.record({
      caseRunId: capability.caseRunId,
      operationId: 'case.report_result',
      transport: 'mcp',
      routeOrTool: 'report_case_result',
      ok: true,
      detail: { status: capability.agentReport.status, summary: capability.agentReport.summary }
    })
    return ok({ accepted: true })
  }
}

export async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const capability = ctx.capabilities.assertAllowed(ctx.capabilityId, name)
  const handler = handlers[name]
  if (!handler) return fail(`unknown_tool:${name}`)

  ctx.ledger.record({
    caseRunId: capability.caseRunId,
    operationId: `mcp.${name}`,
    transport: 'mcp',
    routeOrTool: name,
    ok: true,
    detail: { argsKeys: Object.keys(args) }
  })

  const scopedClient = ctx.client.withCase(capability.caseRunId)
  try {
    return await handler(args, { ...ctx, client: scopedClient })
  } catch (error) {
    ctx.ledger.record({
      caseRunId: capability.caseRunId,
      operationId: `mcp.${name}.error`,
      transport: 'mcp',
      routeOrTool: name,
      ok: false,
      detail: { error: String(error) }
    })
    return fail(String(error))
  }
}

export function listToolsForCapability(
  capabilityId: string,
  capabilities: CapabilityStore
): typeof TOOL_DEFS {
  const capability = capabilities.get(capabilityId)
  if (!capability || capability.revoked) return []
  return TOOL_DEFS.filter((tool) => capability.allowedTools.has(tool.name))
}
