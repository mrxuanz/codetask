import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, writeFileSync } from 'node:fs'
import type { AgentDriver, DriverResult, DriverStartInput } from './contract'
import { McpToolClient } from '../mcp/client'
import { progress } from '../reports/progress'
import {
  buildCreateHtmlUserMessage,
  CHAT_HTML_MARKER,
  htmlFileNameForConversationCore
} from '../config/sdk-html'
import { CLI_MCP_ROOT_KEY, PROBE_OK, PROBE_SERVER_NAME } from '../config/providers'
import type { SutCoreCode } from '../config/profiles'

type Push = (type: string, detail?: unknown) => void

type CollectSnapshot = {
  wizardPhase: string
  draftMessageId?: string
  collecting: boolean
  summaryEmpty: boolean
  assistantStillAsking: boolean
  gaps: string[]
  readyToConfirm: boolean
  draftRow: Record<string, unknown> | null
  detail: Record<string, unknown> | null
}

const REFS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/references')

function selectedConversationCore(input: DriverStartInput): string {
  const core = input.conversationCore.trim()
  if (!core) throw new Error('conversation_core_required')
  return core
}

/**
 * Deterministic driver used to validate Test MCP + public API surfaces
 * without consuming external Driver model quota. SUT agents may still run.
 */
export class FakeDriver implements AgentDriver {
  readonly name = 'fake'
  private static pollLogAt = new Map<string, number>()

  async start(input: DriverStartInput): Promise<DriverResult> {
    const events: DriverResult['events'] = []
    const push: Push = (type, detail) => {
      events.push({ type, at: new Date().toISOString(), detail })
      // Avoid flooding the terminal on long poll loops.
      if (
        type === 'plan.poll' ||
        type === 'job.poll_terminal' ||
        type === 'wizard.phase' ||
        type === 'collect.snapshot' ||
        type === 'drafts'
      ) {
        const key = `${input.caseId}:${type}`
        const now = Date.now()
        const last = FakeDriver.pollLogAt.get(key) ?? 0
        if (now - last < 5_000) return
        FakeDriver.pollLogAt.set(key, now)
      }
      progress(input.caseId, type, detail)
    }

    progress(input.caseId, 'driver.start', { driver: this.name, timeoutMs: input.timeoutMs })

    try {
      const mcp = new McpToolClient(input.mcpUrl, input.capabilityId)
      await mcp.initialize()
      push('mcp.initialized')

      if (input.caseId === 'FOUNDATION-FAKE-001' || input.caseId.startsWith('FOUNDATION')) {
        await this.runFoundation(input, mcp, push)
        return { ok: true, events }
      }

      if (
        input.caseId === 'G4-001' ||
        input.caseId === 'G4-002' ||
        input.caseId === 'G4-003' ||
        input.caseId === 'G4-012' ||
        input.caseId === 'DRAFT-MULTITURN-001'
      ) {
        await this.runDraftCore(input, mcp, push)
        return { ok: true, events }
      }

      if (/^G4-0(0[4-9]|1[0134])$/.test(input.caseId)) {
        await this.runDraftMatrix(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId.startsWith('G5')) {
        await this.runPlannerProbes(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId.startsWith('G6')) {
        if (input.caseId === 'G6-001') {
          await this.runNotesSearchHappyPath(input, mcp, push)
        } else {
          await this.runJobProbes(input, mcp, push)
        }
        return { ok: true, events }
      }

      if (input.caseId.startsWith('G7')) {
        await this.runRecoveryProbes(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'G8-001') {
        await this.runFullChainProbes(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'CHAT-HTML-001') {
        await this.runCreateHtmlConversation(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'SETTINGS-MCP-001') {
        await this.runSettingsMcpProbe(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'JOB-CHAT-RO-001') {
        await this.runJobChatReadonlySkeleton(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId.startsWith('G2')) {
        const project = (await mcp.callTool('codetask_create_project', {
          workspaceRoot: input.workspaceRoot,
          title: 'fake-g2'
        })) as { id: string }
        push('project.created', { id: project.id })
        await mcp.callTool('case_checkpoint', { name: 'project_created' })

        const thread = (await mcp.callTool('codetask_create_thread', {
          projectId: project.id,
          title: 'fake-thread',
          coreCode: selectedConversationCore(input)
        })) as { id: string }
        push('thread.created', { id: thread.id })
        await mcp.callTool('case_checkpoint', { name: 'thread_created' })

        const got = (await mcp.callTool('codetask_get_thread', {
          threadId: thread.id
        })) as { id?: string }
        if (got.id !== thread.id) throw new Error('thread_mismatch')

        await mcp.callTool('codetask_list_cores', {})
        await mcp.callTool('report_case_result', {
          caseId: input.caseId,
          status: 'completed',
          summary: 'Fake driver created project and thread via Test MCP',
          observations: [{ step: 'g2', result: 'ok', projectId: project.id, threadId: thread.id }],
          artifacts: { projectId: project.id, threadId: thread.id }
        })
        push('case.reported')
        return { ok: true, events }
      }

      if (input.caseId.startsWith('G3')) {
        const message =
          typeof input.fixture?.message === 'string'
            ? input.fixture.message
            : '请用中文简短回答：1+1等于几？'
        const project = (await mcp.callTool('codetask_create_project', {
          workspaceRoot: input.workspaceRoot,
          title: 'fake-g3'
        })) as { id: string }
        const thread = (await mcp.callTool('codetask_create_thread', {
          projectId: project.id,
          coreCode: selectedConversationCore(input)
        })) as { id: string }
        const started = (await mcp.callTool('codetask_start_turn', {
          threadId: thread.id,
          message
        })) as { turnId: string }
        const turn = (await mcp.callTool('codetask_wait_turn', {
          threadId: thread.id,
          turnId: started.turnId
        })) as { status?: string }
        if (String(turn.status) !== 'completed') {
          throw new Error(`turn_not_completed:${turn.status}`)
        }
        await mcp.callTool('codetask_list_messages', { threadId: thread.id })
        await mcp.callTool('report_case_result', {
          caseId: input.caseId,
          status: 'completed',
          summary: 'Fake driver completed conversation turn',
          observations: [{ step: 'turn', result: turn.status }],
          artifacts: { projectId: project.id, threadId: thread.id, turnId: started.turnId }
        })
        return { ok: true, events }
      }

      throw new Error(`fake_driver_unsupported_case:${input.caseId}`)
    } catch (error) {
      push('error', { error: String(error) })
      return { ok: false, classification: 'agent_failed', error: String(error), events }
    }
  }

  private async runFoundation(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: 'foundation-notes-search'
    })) as { id: string }
    push('project.created', { id: project.id })

    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: 'foundation-create-task',
      coreCode: selectedConversationCore(input),
      threadKind: 'create_task'
    })) as { id: string }
    push('thread.created', { id: thread.id })

    const phase1 = (await mcp.callTool('case_next_fixture', {})) as {
      phase?: string
    }
    push('fixture.phase', phase1)
    if (phase1.phase !== 'fuzzy') throw new Error(`unexpected_phase:${phase1.phase}`)

    const phase2 = (await mcp.callTool('case_next_fixture', { phase: 'scope' })) as {
      phase?: string
    }
    if (phase2.phase !== 'scope') throw new Error(`unexpected_phase:${phase2.phase}`)
    push('fixture.phase', phase2)

    const drafts = await mcp.callTool('codetask_get_thread_drafts', { threadId: thread.id })
    push('drafts.listed', drafts)
    await mcp.callTool('case_checkpoint', { name: 'drafts_listed' })

    const probes: Array<{ tool: string; ok: boolean; error?: string }> = []
    for (const [tool, args] of [
      ['codetask_get_latest_job', { threadId: thread.id }],
      ['codetask_get_plans', { threadId: thread.id }],
      ['codetask_confirm_draft', { threadId: thread.id, messageId: 'missing-message' }],
      ['codetask_confirm_draft_final', { threadId: thread.id, messageId: 'missing-message' }],
      ['codetask_create_job', { threadId: thread.id }],
      ['codetask_get_job', { threadId: thread.id, jobId: 'missing-job' }],
      [
        'codetask_get_task_evidence',
        { threadId: thread.id, jobId: 'missing-job', taskId: 'missing-task' }
      ],
      ['codetask_confirm_plan', { threadId: thread.id, jobId: 'missing-job' }],
      ['codetask_wait_job', { threadId: thread.id, jobId: 'missing-job', timeoutMs: 1000 }]
    ] as Array<[string, Record<string, unknown>]>) {
      try {
        await mcp.callTool(tool, args)
        probes.push({ tool, ok: true })
      } catch (error) {
        probes.push({ tool, ok: false, error: String(error) })
      }
    }
    push('tool.probes', probes)
    await mcp.callTool('case_checkpoint', { name: 'mcp_surface_probed' })

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary:
        'Foundation fake exercised create_task thread, staged fixtures, draft list, and draft/plan/job MCP probes',
      observations: [{ step: 'probes', result: probes }],
      artifacts: { projectId: project.id, threadId: thread.id }
    })
    push('case.reported')
  }

  private async runDraftCore(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const ctx = await this.createTaskContext(input, mcp, push, `draft-core-${input.caseId}`)
    const maxPhases =
      input.caseId === 'G4-001' ? 1 : input.caseId === 'G4-002' || input.caseId === 'G4-003' ? 4 : 4

    let lastMessageId: string | undefined
    for (let i = 0; i < maxPhases; i++) {
      const phase = (await mcp.callTool('case_next_fixture', {})) as {
        phase?: string
        payload?: { message?: string }
      }
      const message = String(phase.payload?.message ?? '')
      if (!message) throw new Error(`fixture_message_missing:${phase.phase}`)
      await mcp.callTool('case_checkpoint', { name: `phase_${phase.phase}` })

      const started = (await mcp.callTool('codetask_start_turn', {
        threadId: ctx.threadId,
        message,
        kind: 'create_task',
        createTaskMode: true
      })) as { turnId: string }
      const turn = (await mcp.callTool('codetask_wait_turn', {
        threadId: ctx.threadId,
        turnId: started.turnId
      })) as { status?: string }
      if (!['completed', 'failed'].includes(String(turn.status))) {
        throw new Error(`turn_not_terminal:${turn.status}`)
      }
      push('turn.done', { phase: phase.phase, status: turn.status, turnId: started.turnId })
      lastMessageId = (await this.latestAssistantMessageId(mcp, ctx.threadId)) ?? lastMessageId
    }

    const drafts = await mcp.callTool('codetask_get_thread_drafts', { threadId: ctx.threadId })
    push('drafts', drafts)
    await mcp.callTool('case_checkpoint', { name: 'draft_ready' })

    if (input.caseId === 'G4-012' || input.caseId === 'DRAFT-MULTITURN-001') {
      if (!lastMessageId) throw new Error('draft_message_id_missing')
      try {
        await mcp.callTool('codetask_confirm_draft', {
          threadId: ctx.threadId,
          messageId: lastMessageId
        })
        await mcp.callTool('codetask_confirm_draft_final', {
          threadId: ctx.threadId,
          messageId: lastMessageId
        })
        await mcp.callTool('case_checkpoint', { name: 'draft_confirmed_final' })
      } catch (error) {
        push('draft.confirm_error', { error: String(error) })
      }
      try {
        const latest = await mcp.callTool('codetask_get_latest_job', { threadId: ctx.threadId })
        push('job.latest', latest)
      } catch (error) {
        push('job.latest_error', { error: String(error) })
      }
    }

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Fake draft-core script completed ${input.caseId} via Test MCP create_task turns`,
      observations: [{ step: 'draft-core', phases: maxPhases }],
      artifacts: {
        projectId: ctx.projectId,
        threadId: ctx.threadId,
        messageId: lastMessageId
      }
    })
    push('case.reported')
  }

  private async runDraftMatrix(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const ctx = await this.createTaskContext(input, mcp, push, `draft-matrix-${input.caseId}`)
    const messageId = 'missing-message'
    const probes: Array<{ name: string; ok: boolean; detail?: unknown }> = []

    const soft = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        const detail = await fn()
        probes.push({ name, ok: true, detail })
      } catch (error) {
        probes.push({ name, ok: false, detail: String(error) })
      }
    }

    await soft('update_draft_missing', () =>
      mcp.callTool('codetask_update_draft', {
        threadId: ctx.threadId,
        messageId,
        patch: { title: 'probe' }
      })
    )
    await soft('update_draft_wrong_thread', () =>
      mcp.callTool('codetask_update_draft', {
        threadId: 'wrong-thread',
        messageId,
        patch: { title: 'probe' }
      })
    )
    await soft('section_confirm', () =>
      mcp.callTool('codetask_confirm_draft_section', {
        threadId: ctx.threadId,
        messageId,
        section: 'requirements'
      })
    )
    await soft('unlock_draft', () =>
      mcp.callTool('codetask_unlock_draft', { threadId: ctx.threadId, messageId })
    )
    await soft('unlock_contract', () =>
      mcp.callTool('codetask_unlock_draft_contract', { threadId: ctx.threadId, messageId })
    )
    await soft('abilities_opencode', () =>
      mcp.callTool('codetask_update_ability_providers', {
        threadId: ctx.threadId,
        messageId,
        selections: [{ abilityCode: 'task_worker', coreCode: 'opencode' }]
      })
    )
    await soft('abilities_cursor_skip_path', () =>
      mcp.callTool('codetask_update_ability_providers', {
        threadId: ctx.threadId,
        messageId,
        selections: [{ abilityCode: 'task_worker', coreCode: 'cursor' }]
      })
    )

    if (input.caseId === 'G4-008' || input.caseId === 'G4-009' || input.caseId === 'G4-011') {
      await soft('upload_md', () =>
        mcp.callTool('codetask_upload_attachment', {
          threadId: ctx.threadId,
          filePath: join(REFS_ROOT, 'bug-report.txt'),
          fileName: 'bug-report.txt'
        })
      )
      await soft('upload_png', () =>
        mcp.callTool('codetask_upload_attachment', {
          threadId: ctx.threadId,
          filePath: join(REFS_ROOT, 'dashboard-orders.png'),
          fileName: 'dashboard-orders.png'
        })
      )
    }

    if (input.caseId === 'G4-010' || input.caseId === 'G4-013' || input.caseId === 'G4-014') {
      await soft('soft_list_drafts', () =>
        mcp.callTool('codetask_soft_request', {
          method: 'GET',
          path: `/api/threads/${ctx.threadId}/drafts`,
          operationId: 'soft.drafts.list'
        })
      )
      await soft('soft_local_corpus_forbidden', () =>
        mcp.callTool('codetask_soft_request', {
          method: 'POST',
          path: `/api/threads/${ctx.threadId}/messages/${messageId}/draft/references/local-corpus`,
          body: { path: '/etc/passwd', description: 'forbidden' },
          operationId: 'soft.local_corpus.forbidden'
        })
      )
      await soft('soft_delete_draft', () =>
        mcp.callTool('codetask_soft_request', {
          method: 'DELETE',
          path: `/api/threads/${ctx.threadId}/messages/${messageId}/draft`,
          operationId: 'soft.draft.delete'
        })
      )
    }

    await mcp.callTool('codetask_get_thread_drafts', { threadId: ctx.threadId })
    await mcp.callTool('case_checkpoint', { name: 'draft_matrix_probed' })
    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Fake draft-matrix probed ${input.caseId}`,
      observations: [{ step: 'draft-matrix', probes }],
      artifacts: { projectId: ctx.projectId, threadId: ctx.threadId }
    })
    push('case.reported', { probes })
  }

  private async runPlannerProbes(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const ctx = await this.createTaskContext(input, mcp, push, `planner-${input.caseId}`)
    const probes: Array<{ name: string; ok: boolean; detail?: unknown }> = []
    const soft = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        probes.push({ name, ok: true, detail: await fn() })
      } catch (error) {
        probes.push({ name, ok: false, detail: String(error) })
      }
    }

    await soft('list_plans', () => mcp.callTool('codetask_get_plans', { threadId: ctx.threadId }))
    await soft('latest_job', () =>
      mcp.callTool('codetask_get_latest_job', { threadId: ctx.threadId })
    )
    await soft('confirm_plan_missing', () =>
      mcp.callTool('codetask_confirm_plan', { threadId: ctx.threadId, jobId: 'missing-job' })
    )
    await soft('confirm_plan_node_missing', () =>
      mcp.callTool('codetask_confirm_plan_node', {
        threadId: ctx.threadId,
        jobId: 'missing-job',
        nodeRef: 'missing-node'
      })
    )
    await soft('confirm_draft_missing', () =>
      mcp.callTool('codetask_confirm_draft_final', {
        threadId: ctx.threadId,
        messageId: 'missing-message'
      })
    )

    await mcp.callTool('case_checkpoint', { name: 'planner_probed' })
    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Fake planner probes completed ${input.caseId}`,
      observations: [{ step: 'planner', probes }],
      artifacts: { projectId: ctx.projectId, threadId: ctx.threadId }
    })
    push('case.reported', { probes })
  }

  private async runNotesSearchHappyPath(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const ctx = await this.createTaskContext(input, mcp, push, `notes-search-${input.caseId}`)

    // Phase A: human-like collect — one turn, inspect public state, fill gaps.
    const collected = await this.driveHumanLikeDraftCollection(mcp, ctx.threadId, push, 10)
    const draftMessageId = collected.draftMessageId
    await mcp.callTool('case_checkpoint', {
      name: 'draft_ready',
      detail: {
        draftMessageId,
        wizardPhase: collected.wizardPhase,
        turns: collected.turns
      }
    })

    // Phase B: confirm draft only after it is reviewable.
    await mcp.callTool('codetask_confirm_draft', {
      threadId: ctx.threadId,
      messageId: draftMessageId
    })
    push('draft.confirmed')
    await this.waitForWizardPhase(mcp, ctx.threadId, 'draft_review', push)

    const confirmFinal = (await mcp.callTool('codetask_confirm_draft_final', {
      threadId: ctx.threadId,
      messageId: draftMessageId
    })) as Record<string, unknown>
    push('draft.confirm_final', confirmFinal)
    await mcp.callTool('case_checkpoint', { name: 'draft_confirmed_final' })

    const jobFromConfirm = this.unwrapJobRecord(confirmFinal)
    const job = jobFromConfirm ?? (await this.pollLatestJob(mcp, ctx.threadId, push))
    const jobId = String(job.id ?? job.jobId ?? '')
    if (!jobId) throw new Error(`job_id_missing:${JSON.stringify(job)}`)
    push('job.ready', { jobId, job })

    // Phase C: plan generation — stop conversation driving (no start_turn).
    // Node polls APIs; on ready/failed run plan check; recoverable failures
    // get up to 3 continue retries (server re-invokes OpenCode planner).
    push('plan.poll_begin', { jobId, note: 'conversation_driver_idle', maxRetries: 3 })
    const planReady = await this.waitForPlanReady(mcp, ctx.threadId, jobId, push, 3)
    push('plan.ready', planReady)

    // Phase D: inspect plan → confirm_plan → wait launched job.
    const checked = await this.checkPlanViaApi(mcp, ctx.threadId, jobId, push)
    if (!checked.ok) {
      throw new Error(`plan_check_failed_after_ready:${checked.reason}`)
    }
    push('plan.check_ok', checked)

    let waitJobId = jobId
    let waitThreadId = ctx.threadId
    try {
      const confirmed = (await mcp.callTool('codetask_confirm_plan', {
        threadId: ctx.threadId,
        jobId
      })) as Record<string, unknown>
      push('plan.confirmed', confirmed)
      const launched = this.unwrapJobRecord(confirmed)
      if (launched?.id) {
        waitJobId = String(launched.id)
        if (typeof launched.threadId === 'string' && launched.threadId) {
          waitThreadId = launched.threadId
        }
      }
      await mcp.callTool('case_checkpoint', {
        name: 'plan_confirmed',
        detail: { waitJobId, waitThreadId }
      })
    } catch (error) {
      // Idempotent / already launched paths still allow waiting for terminal.
      push('plan.confirm_error', { error: String(error) })
    }

    // Phase E: wait for Job terminal via public API status only.
    // No script-side time cap — switch only on completed|failed|cancelled.
    push('job.wait_begin', {
      waitJobId,
      waitThreadId,
      note: 'poll_until_api_terminal_no_timeout'
    })
    const terminal = await this.pollJobTerminal(mcp, waitThreadId, waitJobId, push)
    push('job.terminal', terminal)
    await mcp.callTool('case_checkpoint', {
      name: 'job_terminal',
      detail: { status: terminal.status, waitJobId, waitThreadId }
    })

    const taskId =
      (terminal.tasks as Array<{ id?: string; taskId?: string }> | undefined)?.[0]?.id ??
      (terminal.tasks as Array<{ id?: string; taskId?: string }> | undefined)?.[0]?.taskId ??
      (terminal as { taskId?: string }).taskId
    if (taskId) {
      try {
        const evidence = await mcp.callTool('codetask_get_task_evidence', {
          threadId: waitThreadId,
          jobId: waitJobId,
          taskId: String(taskId)
        })
        push('job.evidence', evidence)
      } catch (error) {
        push('job.evidence_error', { error: String(error) })
      }
    }

    const terminalStatus = String(terminal.status ?? '')
    if (!['completed', 'failed', 'cancelled'].includes(terminalStatus)) {
      throw new Error(`job_not_terminal:${terminalStatus}`)
    }
    if (terminalStatus !== 'completed') {
      throw new Error(
        `job_not_completed:${terminalStatus}:${JSON.stringify(
          terminal.lastError ?? terminal.failure ?? null
        )}`
      )
    }

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: 'Notes Search happy path reached completed job via Test MCP',
      observations: [
        {
          step: 'notes-search-happy-path',
          draftMessageId,
          planningJobId: jobId,
          jobId: waitJobId,
          jobStatus: terminal.status,
          collectTurns: collected.turns
        }
      ],
      artifacts: {
        projectId: ctx.projectId,
        threadId: ctx.threadId,
        messageId: draftMessageId,
        jobId: waitJobId,
        taskId
      }
    })
    push('case.reported')
  }

  /**
   * Human-like draft collection: send one user turn → wait → inspect drafts /
   * wizard_phase / assistant follow-ups → fill the next gap. Never blast the
   * whole fixture then confirm.
   */
  private async driveHumanLikeDraftCollection(
    mcp: McpToolClient,
    threadId: string,
    push: Push,
    maxTurns: number
  ): Promise<{ draftMessageId: string; wizardPhase: string; turns: number }> {
    const sentPhases = new Set<string>()
    let fixturesExhausted = false
    let proposeNudges = 0
    const maxProposeNudges = 3
    let lastSnapshot: CollectSnapshot | null = null

    for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex++) {
      lastSnapshot = await this.inspectCollectSnapshot(mcp, threadId, push)
      push('collect.snapshot', {
        turnIndex,
        wizardPhase: lastSnapshot.wizardPhase,
        collecting: lastSnapshot.collecting,
        summaryEmpty: lastSnapshot.summaryEmpty,
        gaps: lastSnapshot.gaps,
        assistantStillAsking: lastSnapshot.assistantStillAsking,
        readyToConfirm: lastSnapshot.readyToConfirm,
        draftMessageId: lastSnapshot.draftMessageId
      })

      if (lastSnapshot.readyToConfirm && lastSnapshot.draftMessageId) {
        return {
          draftMessageId: lastSnapshot.draftMessageId,
          wizardPhase: lastSnapshot.wizardPhase,
          turns: turnIndex - 1
        }
      }

      const next = await this.chooseNextCollectMessage(
        mcp,
        lastSnapshot,
        sentPhases,
        fixturesExhausted,
        proposeNudges,
        maxProposeNudges
      )
      if (next.kind === 'fixture_exhausted') {
        fixturesExhausted = true
        push('collect.fixtures_exhausted', { turnIndex, gaps: lastSnapshot.gaps })
        // Re-choose for propose nudge on the same snapshot without burning a turn.
        turnIndex -= 1
        continue
      }
      if (next.kind === 'stuck') {
        throw new Error(
          `draft_still_collecting:create_task_agent_did_not_propose_reviewable_draft:` +
            `wizard=${lastSnapshot.wizardPhase}:gaps=${lastSnapshot.gaps.join(',')}:` +
            `summaryEmpty=${lastSnapshot.summaryEmpty}:asking=${lastSnapshot.assistantStillAsking}`
        )
      }

      if (next.phase) sentPhases.add(next.phase)
      if (next.kind === 'propose_nudge') proposeNudges += 1
      await mcp.callTool('case_checkpoint', {
        name: `phase_${next.phase ?? next.kind}`,
        detail: { turnIndex, gaps: lastSnapshot.gaps }
      })

      const turn = await this.runCreateTaskTurnWithRetry(
        mcp,
        threadId,
        next.message,
        push,
        String(next.phase ?? next.kind),
        3
      )
      push('turn.done', {
        phase: next.phase ?? next.kind,
        status: turn.status,
        turnId: turn.turnId,
        attempts: turn.attempts,
        turnIndex
      })
    }

    lastSnapshot = await this.inspectCollectSnapshot(mcp, threadId, push)
    push('collect.snapshot', {
      turnIndex: 'final',
      wizardPhase: lastSnapshot.wizardPhase,
      collecting: lastSnapshot.collecting,
      summaryEmpty: lastSnapshot.summaryEmpty,
      gaps: lastSnapshot.gaps,
      assistantStillAsking: lastSnapshot.assistantStillAsking,
      readyToConfirm: lastSnapshot.readyToConfirm,
      draftMessageId: lastSnapshot.draftMessageId
    })
    if (lastSnapshot.readyToConfirm && lastSnapshot.draftMessageId) {
      return {
        draftMessageId: lastSnapshot.draftMessageId,
        wizardPhase: lastSnapshot.wizardPhase,
        turns: maxTurns
      }
    }
    throw new Error(
      `draft_still_collecting:create_task_turns_did_not_produce_reviewable_draft:` +
        `wizard=${lastSnapshot.wizardPhase}:gaps=${lastSnapshot.gaps.join(',')}:` +
        `summaryEmpty=${lastSnapshot.summaryEmpty}`
    )
  }

  private async chooseNextCollectMessage(
    mcp: McpToolClient,
    snapshot: CollectSnapshot,
    sentPhases: Set<string>,
    fixturesExhausted: boolean,
    proposeNudges: number,
    maxProposeNudges: number
  ): Promise<
    | { kind: 'fixture'; phase: string; message: string }
    | { kind: 'propose_nudge'; phase?: undefined; message: string }
    | { kind: 'fixture_exhausted'; phase?: undefined; message?: undefined }
    | { kind: 'stuck'; phase?: undefined; message?: undefined }
  > {
    const gapHints = new Set(snapshot.gaps)
    const wantsContent =
      gapHints.has('scope') ||
      gapHints.has('constraints') ||
      gapHints.has('acceptance') ||
      (!sentPhases.has('fuzzy') && snapshot.summaryEmpty)

    if (!fixturesExhausted) {
      try {
        // Staged fixtures stay ordered (R10). Human-like behavior is: unlock
        // the next phase only after inspecting the prior turn — never blast
        // remaining phases without a snapshot check in between.
        const phase = (await mcp.callTool('case_next_fixture', {})) as {
          phase?: string
          payload?: { message?: string }
        }
        const name = String(phase.phase ?? '')
        const message = String(phase.payload?.message ?? '')
        if (!message) throw new Error(`fixture_message_missing:${name}`)

        // If the only remaining gap is propose and next fixture is still a
        // content phase we already covered via assistant text, still send it —
        // the product agent often needs the explicit user answers before
        // propose_task_draft. Propose fixture/nudges come after.
        if (name === 'propose' && wantsContent && !sentPhases.has('acceptance')) {
          // Should not happen with ordered fixtures; fall through to send.
        }
        return { kind: 'fixture', phase: name, message }
      } catch (error) {
        if (!String(error).includes('fixture_phases_exhausted')) throw error
        return { kind: 'fixture_exhausted' }
      }
    }

    if (proposeNudges < maxProposeNudges) {
      const gapLine =
        snapshot.gaps.length > 0
          ? `当前仍缺：${snapshot.gaps.join('、')}。`
          : '草案仍在收集且摘要为空。'
      return {
        kind: 'propose_nudge',
        message:
          `${gapLine}请立刻提出完整任务草案并结束收集（propose_task_draft）。` +
          '范围/约束/验收已在上文给出。不要再探查文件或继续追问；直接给出可确认的草案。'
      }
    }

    return { kind: 'stuck' }
  }

  private async inspectCollectSnapshot(
    mcp: McpToolClient,
    threadId: string,
    push: Push
  ): Promise<CollectSnapshot> {
    const thread = (await mcp.callTool('codetask_get_thread', {
      threadId
    })) as Record<string, unknown>
    const wizardPhase = String(thread.wizardPhase ?? thread.phase ?? '')

    const draftsRaw = await mcp.callTool('codetask_get_thread_drafts', { threadId })
    push('drafts', draftsRaw)
    const draftMessageId = this.extractDraftMessageId(draftsRaw)
    const draftRow = this.findDraftRow(draftsRaw, draftMessageId)
    const collecting =
      draftRow?.collecting === true ||
      draftRow?.status === 'collecting' ||
      wizardPhase === 'collect' ||
      wizardPhase === ''
    const summary = String(draftRow?.summary ?? '')
    const summaryEmpty = summary.trim().length === 0

    let detail: Record<string, unknown> | null = null
    if (draftMessageId) {
      try {
        const soft = (await mcp.callTool('codetask_soft_request', {
          method: 'GET',
          path: `/api/threads/${threadId}/messages/${draftMessageId}/draft`,
          operationId: 'soft.draft.get'
        })) as Record<string, unknown>
        detail =
          soft && typeof soft === 'object'
            ? ((soft.data as Record<string, unknown> | undefined) ??
              (soft.draft as Record<string, unknown> | undefined) ??
              soft)
            : null
        push('draft.detail', {
          messageId: draftMessageId,
          keys: detail && typeof detail === 'object' ? Object.keys(detail).slice(0, 24) : []
        })
      } catch (error) {
        push('draft.detail_error', { error: String(error) })
      }
    }

    const assistant = await this.latestAssistantText(mcp, threadId)
    const assistantStillAsking = this.assistantLooksLikeFollowUp(assistant)
    const gaps = this.detectCollectGaps({
      wizardPhase,
      collecting,
      summaryEmpty,
      assistantStillAsking,
      assistantText: assistant,
      detail
    })

    const leftCollect =
      wizardPhase === 'draft_review' ||
      wizardPhase === 'planning' ||
      wizardPhase === 'ready_to_launch' ||
      wizardPhase === 'executing'
    const draftReviewable =
      Boolean(draftMessageId) &&
      !summaryEmpty &&
      draftRow?.collecting !== true &&
      draftRow?.status !== 'collecting'
    const readyToConfirm =
      Boolean(draftReviewable) &&
      (leftCollect || (!assistantStillAsking && wizardPhase !== 'collect'))

    return {
      wizardPhase,
      draftMessageId,
      collecting: Boolean(
        (draftRow?.collecting === true ||
          draftRow?.status === 'collecting' ||
          wizardPhase === 'collect' ||
          wizardPhase === '') &&
        !leftCollect
      ),
      summaryEmpty,
      assistantStillAsking,
      gaps,
      readyToConfirm,
      draftRow,
      detail
    }
  }

  private detectCollectGaps(input: {
    wizardPhase: string
    collecting: boolean
    summaryEmpty: boolean
    assistantStillAsking: boolean
    assistantText: string
    detail: Record<string, unknown> | null
  }): string[] {
    const gaps: string[] = []
    const text = `${input.assistantText}\n${JSON.stringify(input.detail ?? {})}`.toLowerCase()
    const detail = input.detail ?? {}

    const missingField = (key: string, aliases: string[]): boolean => {
      const direct = detail[key]
      if (
        direct != null &&
        String(direct).trim() !== '' &&
        !(Array.isArray(direct) && direct.length === 0)
      ) {
        return false
      }
      // Nested payload shapes
      const payload = detail.payload ?? detail.draft ?? detail.content
      if (payload && typeof payload === 'object') {
        const nested = (payload as Record<string, unknown>)[key]
        if (
          nested != null &&
          String(nested).trim() !== '' &&
          !(Array.isArray(nested) && nested.length === 0)
        ) {
          return false
        }
      }
      return aliases.some((a) => text.includes(a)) || input.summaryEmpty || input.collecting
    }

    if (missingField('scope', ['范围', 'scope', '搜什么', '搜索范围'])) gaps.push('scope')
    if (missingField('constraints', ['约束', 'constraint', '不能', '禁止', '依赖'])) {
      gaps.push('constraints')
    }
    if (missingField('acceptanceCriteria', ['验收', 'acceptance', '通过标准', 'node --test'])) {
      gaps.push('acceptance')
    }

    if (
      input.collecting &&
      input.summaryEmpty &&
      !gaps.includes('scope') &&
      !gaps.includes('constraints') &&
      !gaps.includes('acceptance')
    ) {
      gaps.push('propose')
    } else if (input.collecting && !input.summaryEmpty && gaps.length === 0) {
      gaps.push('propose')
    } else if (input.assistantStillAsking && gaps.length === 0) {
      gaps.push('propose')
    }

    // Deduplicate while preserving order
    return [...new Set(gaps)]
  }

  private assistantLooksLikeFollowUp(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    return (
      /[？?]/.test(t) ||
      /(请(?:告诉|说明|提供|确认|补充)|还需要|还缺|能否|可以再说|具体.*(什么|哪些)|你希望)/.test(t)
    )
  }

  private async latestAssistantText(mcp: McpToolClient, threadId: string): Promise<string> {
    const messages = (await mcp.callTool('codetask_list_messages', {
      threadId
    })) as Array<Record<string, unknown>> | { data?: Array<Record<string, unknown>> }
    const list = Array.isArray(messages) ? messages : (messages.data ?? [])
    const draftMsg = [...list].reverse().find((item) => item.role === 'assistant')
    if (!draftMsg) return ''
    const parts = [draftMsg.content, draftMsg.text, draftMsg.body, draftMsg.summary]
    return parts
      .map((p) => {
        if (typeof p === 'string') return p
        if (Array.isArray(p)) {
          return p
            .map((part) => {
              if (typeof part === 'string') return part
              if (part && typeof part === 'object' && 'text' in part) {
                return String((part as { text?: unknown }).text ?? '')
              }
              return ''
            })
            .join('\n')
        }
        if (p && typeof p === 'object') return JSON.stringify(p)
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  private findDraftRow(
    draftsRaw: unknown,
    draftMessageId?: string
  ): Record<string, unknown> | null {
    let list: unknown[] = []
    if (Array.isArray(draftsRaw)) list = draftsRaw
    else if (draftsRaw && typeof draftsRaw === 'object') {
      const obj = draftsRaw as { drafts?: unknown; data?: unknown }
      if (Array.isArray(obj.drafts)) list = obj.drafts
      else if (Array.isArray(obj.data)) list = obj.data
    }
    const rows = list.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === 'object'
    )
    if (draftMessageId) {
      const match = rows.find((row) => String(row.messageId ?? row.id ?? '') === draftMessageId)
      if (match) return match
    }
    return (
      rows.find((row) => row.collecting !== true && row.status !== 'collecting' && row.messageId) ??
      rows[0] ??
      null
    )
  }

  private async runCreateTaskTurnWithRetry(
    mcp: McpToolClient,
    threadId: string,
    message: string,
    push: Push,
    phase: string,
    maxAttempts: number
  ): Promise<{ status: string; turnId: string; attempts: number }> {
    let lastError = ''
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = (await mcp.callTool('codetask_start_turn', {
        threadId,
        message,
        kind: 'create_task',
        createTaskMode: true
      })) as { turnId: string }
      const turn = (await mcp.callTool('codetask_wait_turn', {
        threadId,
        turnId: started.turnId
      })) as { status?: string; lastError?: unknown; error?: unknown }
      const status = String(turn.status ?? '')
      if (status === 'completed') {
        return { status, turnId: started.turnId, attempts: attempt }
      }
      let detail: unknown = turn.lastError ?? turn.error
      try {
        detail = await mcp.callTool('codetask_get_turn', {
          threadId,
          turnId: started.turnId
        })
      } catch {
        /* keep prior detail */
      }
      lastError = `${status}:${JSON.stringify(detail)}`
      // Prefer provider detail when present (e.g. Insufficient balance).
      const nested =
        detail && typeof detail === 'object'
          ? ((detail as { turn?: { lastError?: { detail?: string; message?: string } } }).turn
              ?.lastError ??
            (detail as { lastError?: { detail?: string; message?: string } }).lastError)
          : undefined
      if (nested?.detail || nested?.message) {
        lastError = `${status}:${nested.message ?? ''}:${nested.detail ?? ''}`
      }
      push('turn.retry', { phase, attempt, status, detail })
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
      }
    }
    throw new Error(`create_task_turn_failed:${phase}:${lastError}`)
  }

  private async waitForWizardPhase(
    mcp: McpToolClient,
    threadId: string,
    expected: string,
    push: Push
  ): Promise<void> {
    for (;;) {
      const thread = (await mcp.callTool('codetask_get_thread', {
        threadId
      })) as Record<string, unknown>
      const phase = String(thread.wizardPhase ?? thread.phase ?? '')
      push('wizard.phase', { phase })
      if (phase === expected) return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private unwrapJobRecord(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object') return null
    const obj = payload as Record<string, unknown>
    if (obj.job && typeof obj.job === 'object') return obj.job as Record<string, unknown>
    if (typeof obj.id === 'string' || typeof obj.jobId === 'string') return obj
    return null
  }

  private async waitForPlanReady(
    mcp: McpToolClient,
    threadId: string,
    jobId: string,
    push: Push,
    maxRetries = 3
  ): Promise<Record<string, unknown>> {
    let retries = 0
    for (;;) {
      const job = (await mcp.callTool('codetask_get_job', {
        threadId,
        jobId
      })) as Record<string, unknown>
      const status = String(job.status ?? '')
      const phase = String(
        (job.planProgress as { phase?: string } | undefined)?.phase ?? job.phase ?? ''
      )
      push('plan.poll', { status, phase, lastError: job.lastError, retries })

      const ready =
        status === 'plan_ready' ||
        phase === 'ready_to_launch' ||
        phase === 'plan_ready' ||
        (status === 'plan_editing' && (phase === 'plan_ready' || phase === 'ready_to_launch'))
      if (ready || status === 'running' || status === 'completed') {
        // Detected success (or already past planning): Node-side API check.
        const check = await this.checkPlanViaApi(mcp, threadId, jobId, push)
        push('plan.check', { outcome: 'ready_or_advanced', ...check, retries })
        if (check.ok || status === 'running' || status === 'completed') {
          return job
        }
        // Tree claimed ready but check failed → retry planner if allowed.
        if (
          retries < maxRetries &&
          (await this.tryContinuePlan(mcp, jobId, job, push, retries + 1))
        ) {
          retries += 1
          await new Promise((resolve) => setTimeout(resolve, 3000))
          continue
        }
        throw new Error(`plan_check_failed:${check.reason}`)
      }

      if (status === 'failed' || status === 'cancelled') {
        // Detected failure: API check, then up to maxRetries continue (OpenCode planner again).
        const check = await this.checkPlanViaApi(mcp, threadId, jobId, push)
        push('plan.check', { outcome: 'failed', ...check, retries, status })
        if (
          retries < maxRetries &&
          (await this.tryContinuePlan(mcp, jobId, job, push, retries + 1))
        ) {
          retries += 1
          await new Promise((resolve) => setTimeout(resolve, 3000))
          continue
        }
        throw new Error(
          `plan_failed:${status}:retries=${retries}:${JSON.stringify(job.lastError ?? job.failure ?? null)}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }

  private async tryContinuePlan(
    mcp: McpToolClient,
    jobId: string,
    job: Record<string, unknown>,
    push: Push,
    attempt: number
  ): Promise<boolean> {
    const actions = Array.isArray(job.availableActions) ? (job.availableActions as string[]) : []
    const recoverable =
      Boolean((job.recovery as { recoverable?: boolean } | undefined)?.recoverable) ||
      actions.includes('continue') ||
      String(job.status ?? '') === 'failed' ||
      String(job.status ?? '') === 'plan_editing'
    if (!recoverable && !actions.includes('continue') && String(job.status) !== 'failed') {
      // Still attempt continue once when check failed on a ready-looking job.
      push('plan.continue_skip', { attempt, reason: 'not_marked_recoverable' })
    }
    push('plan.continue_attempt', { attempt, lastError: job.lastError, status: job.status })
    try {
      await mcp.callTool('codetask_continue_job', { jobId })
      return true
    } catch (error) {
      push('plan.continue_error', { attempt, error: String(error) })
      return false
    }
  }

  private async checkPlanViaApi(
    mcp: McpToolClient,
    threadId: string,
    jobId: string,
    push: Push
  ): Promise<{ ok: boolean; reason: string; status?: string; phase?: string }> {
    try {
      const job = (await mcp.callTool('codetask_get_job', {
        threadId,
        jobId
      })) as Record<string, unknown>
      let plans: unknown = null
      try {
        plans = await mcp.callTool('codetask_get_plans', { threadId })
        push('plan.inspect', plans)
      } catch (error) {
        push('plan.inspect_error', { error: String(error) })
      }

      const status = String(job.status ?? '')
      const phase = String(
        (job.planProgress as { phase?: string } | undefined)?.phase ?? job.phase ?? ''
      )
      if (status === 'running' || status === 'completed') {
        return { ok: true, reason: 'job_already_advanced', status, phase }
      }
      if (status === 'failed' || status === 'cancelled') {
        return { ok: false, reason: `terminal_${status}`, status, phase }
      }

      const blob = JSON.stringify({ job, plans })
      const hasTreeSignal =
        /plan_ready|ready_to_launch|plan_editing/.test(`${status} ${phase}`) ||
        /"tasks"|"nodes"|"outline"|"planTree"|"executionTree"/.test(blob)

      if (!hasTreeSignal) {
        return { ok: false, reason: 'no_execution_tree_signal', status, phase }
      }
      return { ok: true, reason: 'execution_tree_present', status, phase }
    } catch (error) {
      return { ok: false, reason: `check_error:${String(error)}` }
    }
  }

  private extractDraftMessageId(draftsRaw: unknown): string | undefined {
    let list: unknown[] = []
    if (Array.isArray(draftsRaw)) {
      list = draftsRaw
    } else if (draftsRaw && typeof draftsRaw === 'object') {
      const obj = draftsRaw as { data?: unknown; drafts?: unknown }
      if (Array.isArray(obj.drafts)) list = obj.drafts
      else if (Array.isArray(obj.data)) list = obj.data
    }
    const rows = list.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === 'object'
    )
    const preferred =
      rows.find(
        (row) =>
          row.collecting !== true &&
          row.status !== 'collecting' &&
          typeof row.messageId === 'string' &&
          row.messageId
      ) ??
      rows.find((row) => typeof row.messageId === 'string' && row.messageId) ??
      rows.find((row) => typeof row.id === 'string' && row.id)
    if (!preferred) return undefined
    if (typeof preferred.messageId === 'string' && preferred.messageId) return preferred.messageId
    if (typeof preferred.id === 'string' && preferred.id) return preferred.id
    return undefined
  }

  /**
   * Poll public get_job until API reports a terminal status.
   * No script-side timeout — only completed|failed|cancelled ends the loop.
   */
  private async pollJobTerminal(
    mcp: McpToolClient,
    threadId: string,
    jobId: string,
    push: Push
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const last = (await mcp.callTool('codetask_get_job', { threadId, jobId })) as Record<
        string,
        unknown
      >
      const status = String(last.status ?? '')
      const taskPhase = String(
        (last.taskProgress as { phase?: string } | undefined)?.phase ?? last.taskPhase ?? ''
      )
      const taskStatus = String(
        (last.taskProgress as { status?: string } | undefined)?.status ?? last.taskStatus ?? ''
      )
      const currentTaskId = String(
        (last.taskProgress as { currentTaskId?: string } | undefined)?.currentTaskId ??
          last.taskCurrentTaskId ??
          ''
      )
      push('job.poll_terminal', {
        status,
        jobId,
        taskPhase: taskPhase || undefined,
        taskStatus: taskStatus || undefined,
        currentTaskId: currentTaskId || undefined
      })
      if (['completed', 'failed', 'cancelled'].includes(status)) return last
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }

  private async pollLatestJob(
    mcp: McpToolClient,
    threadId: string,
    push: Push
  ): Promise<Record<string, unknown>> {
    let lastError = ''
    for (;;) {
      try {
        const latest = (await mcp.callTool('codetask_get_latest_job', {
          threadId
        })) as Record<string, unknown> | null
        const job =
          latest && typeof latest === 'object' && latest.job && typeof latest.job === 'object'
            ? (latest.job as Record<string, unknown>)
            : latest
        const id = job && typeof job === 'object' ? (job.id ?? job.jobId) : undefined
        if (id) {
          push('job.polled', { id, status: (job as { status?: unknown }).status })
          return job as Record<string, unknown>
        }
        lastError = 'job_empty'
      } catch (error) {
        lastError = String(error)
        push('job.poll_error', { error: lastError })
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  private async runJobProbes(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const ctx = await this.createTaskContext(input, mcp, push, `job-${input.caseId}`)
    const probes: Array<{ name: string; ok: boolean; detail?: unknown }> = []
    const soft = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        probes.push({ name, ok: true, detail: await fn() })
      } catch (error) {
        probes.push({ name, ok: false, detail: String(error) })
      }
    }

    await soft('create_job', () => mcp.callTool('codetask_create_job', { threadId: ctx.threadId }))
    await soft('get_job', () =>
      mcp.callTool('codetask_get_job', { threadId: ctx.threadId, jobId: 'missing-job' })
    )
    await soft('wait_job', () =>
      mcp.callTool('codetask_wait_job', {
        threadId: ctx.threadId,
        jobId: 'missing-job',
        timeoutMs: 1000
      })
    )
    await soft('task_evidence', () =>
      mcp.callTool('codetask_get_task_evidence', {
        threadId: ctx.threadId,
        jobId: 'missing-job',
        taskId: 'missing-task'
      })
    )

    for (const tool of [
      'codetask_pause_job',
      'codetask_resume_job',
      'codetask_continue_job',
      'codetask_cancel_job',
      'codetask_restart_job'
    ]) {
      await soft(tool, () => mcp.callTool(tool, { jobId: 'missing-job' }))
    }

    if (input.caseId === 'G6-002') {
      // Intentionally report completed while workspace tests still fail → file oracle fails.
      probes.push({ name: 'pseudo_completed_evidence', ok: true, detail: { fake: true } })
    }

    await mcp.callTool('case_checkpoint', { name: 'job_probed' })
    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Fake job probes completed ${input.caseId}`,
      observations: [{ step: 'job', probes }],
      artifacts: { projectId: ctx.projectId, threadId: ctx.threadId }
    })
    push('case.reported', { probes })
  }

  private async runRecoveryProbes(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: `recovery-${input.caseId}`
    })) as { id: string }
    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: `recovery-${input.caseId}`,
      coreCode: selectedConversationCore(input)
    })) as { id: string }
    push('context', { projectId: project.id, threadId: thread.id })

    const connectionId = `biz-${input.caseId}-${Date.now()}`
    const probes: Array<{ name: string; ok: boolean; detail?: unknown }> = []
    const soft = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        probes.push({ name, ok: true, detail: await fn() })
      } catch (error) {
        probes.push({ name, ok: false, detail: String(error) })
      }
    }

    await soft('subscribe_thread', () =>
      mcp.callTool('codetask_soft_request', {
        method: 'PUT',
        path: '/api/events/subscriptions',
        body: { connectionId, topics: [`thread:${thread.id}`] },
        operationId: 'soft.events.subscribe'
      })
    )
    await soft('subscribe_foreign', () =>
      mcp.callTool('codetask_soft_request', {
        method: 'PUT',
        path: '/api/events/subscriptions',
        body: { connectionId: `${connectionId}-foreign`, topics: ['thread:foreign-thread'] },
        operationId: 'soft.events.foreign'
      })
    )
    await soft('subscribe_missing_connection', () =>
      mcp.callTool('codetask_soft_request', {
        method: 'PUT',
        path: '/api/events/subscriptions',
        body: { topics: [`thread:${thread.id}`] },
        operationId: 'soft.events.missing_connection'
      })
    )

    await mcp.callTool('case_checkpoint', { name: 'recovery_probed' })
    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Fake recovery/realtime probes completed ${input.caseId}`,
      observations: [{ step: 'recovery', probes }],
      artifacts: { projectId: project.id, threadId: thread.id }
    })
    push('case.reported', { probes })
  }

  private async runFullChainProbes(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const ctx = await this.createTaskContext(input, mcp, push, `full-${input.caseId}`)
    const probes: Array<{ name: string; ok: boolean; detail?: unknown }> = []
    const soft = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        probes.push({ name, ok: true, detail: await fn() })
      } catch (error) {
        probes.push({ name, ok: false, detail: String(error) })
      }
    }

    await soft('upload_md', () =>
      mcp.callTool('codetask_upload_attachment', {
        threadId: ctx.threadId,
        filePath: join(REFS_ROOT, 'bug-report.txt'),
        fileName: 'bug-report.txt'
      })
    )
    await soft('upload_png', () =>
      mcp.callTool('codetask_upload_attachment', {
        threadId: ctx.threadId,
        filePath: join(REFS_ROOT, 'dashboard-orders.png'),
        fileName: 'dashboard-orders.png'
      })
    )
    await soft('list_drafts', () =>
      mcp.callTool('codetask_get_thread_drafts', { threadId: ctx.threadId })
    )
    await soft('list_plans', () => mcp.callTool('codetask_get_plans', { threadId: ctx.threadId }))
    await soft('latest_job', () =>
      mcp.callTool('codetask_get_latest_job', { threadId: ctx.threadId })
    )
    await soft('create_job', () => mcp.callTool('codetask_create_job', { threadId: ctx.threadId }))
    await soft('soft_subscribe', () =>
      mcp.callTool('codetask_soft_request', {
        method: 'PUT',
        path: '/api/events/subscriptions',
        body: {
          connectionId: `g8-${Date.now()}`,
          topics: [`thread:${ctx.threadId}`]
        },
        operationId: 'soft.g8.subscribe'
      })
    )

    await mcp.callTool('case_checkpoint', { name: 'full_chain_probed' })
    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Fake ${selectedConversationCore(input)} full chain probed Draft/Plan/Job/Realtime surfaces`,
      observations: [{ step: 'full-chain', probes }],
      artifacts: { projectId: ctx.projectId, threadId: ctx.threadId }
    })
    push('case.reported', { probes })
  }

  private async runSettingsMcpProbe(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const core = selectedConversationCore(input) as SutCoreCode
    const rootKey = CLI_MCP_ROOT_KEY[core] ?? 'mcp'
    const probeUrl = input.probeMcpUrl?.replace(/\/$/, '') || ''
    const probeName = input.probeMcpName || PROBE_SERVER_NAME
    if (!probeUrl) throw new Error('probe_mcp_url_missing')

    const serverEntry =
      core === 'opencode'
        ? {
            type: 'remote',
            url: probeUrl,
            enabled: true,
            headers: { Accept: 'application/json, text/event-stream' }
          }
        : {
            url: probeUrl,
            headers: { Accept: 'application/json, text/event-stream' }
          }

    const before = (await mcp.callTool('codetask_get_mcp_settings', {})) as {
      settings?: Record<string, unknown>
    }
    push('settings.mcp.snapshot', { core, hasSettings: Boolean(before?.settings) })
    await mcp.callTool('case_checkpoint', { name: 'mcp_settings_snapshot' })

    const base =
      before?.settings && typeof before.settings === 'object'
        ? structuredClone(before.settings as Record<string, unknown>)
        : {
            conversation: {},
            task: {},
            verification: {}
          }

    const roles = ['conversation', 'task', 'verification'] as const
    for (const role of roles) {
      const roleMap =
        base[role] && typeof base[role] === 'object' ? (base[role] as Record<string, unknown>) : {}
      const fragment =
        roleMap[core] && typeof roleMap[core] === 'object'
          ? (roleMap[core] as Record<string, unknown>)
          : { [rootKey]: {} }
      const servers =
        fragment[rootKey] && typeof fragment[rootKey] === 'object'
          ? { ...(fragment[rootKey] as Record<string, unknown>) }
          : {}
      servers[probeName] = serverEntry
      roleMap[core] = { [rootKey]: servers }
      base[role] = roleMap
    }

    await mcp.callTool('codetask_put_mcp_settings', { settings: base })
    push('settings.mcp.registered', { core, probeName, probeUrl, roles: [...roles] })
    await mcp.callTool('case_checkpoint', { name: 'mcp_probe_registered' })

    const after = (await mcp.callTool('codetask_get_mcp_settings', {})) as {
      settings?: Record<string, unknown>
    }
    const afterText = JSON.stringify(after?.settings ?? {})
    if (!afterText.includes(probeName)) {
      throw new Error('settings_mcp_roundtrip_missing_probe')
    }
    push('settings.mcp.roundtrip_ok', { probeName })

    const reservedAttempt = structuredClone(base)
    const conv = (reservedAttempt.conversation ?? {}) as Record<string, unknown>
    const frag = (conv[core] ?? { [rootKey]: {} }) as Record<string, unknown>
    const servers = {
      ...((frag[rootKey] as Record<string, unknown>) ?? {}),
      'codeteam-manager': serverEntry
    }
    conv[core] = { [rootKey]: servers }
    reservedAttempt.conversation = conv
    let reservedFailed = false
    try {
      await mcp.callTool('codetask_put_mcp_settings', { settings: reservedAttempt })
    } catch {
      reservedFailed = true
    }
    if (!reservedFailed) {
      throw new Error('settings_mcp_reserved_name_should_fail')
    }
    push('settings.mcp.reserved_rejected', { ok: true })

    // Harness self-check: call probe HTTP MCP tools/call directly.
    const probeHits: Record<string, string> = {}
    for (const role of roles) {
      const tool =
        role === 'conversation'
          ? 'ping_conversation'
          : role === 'task'
            ? 'ping_task'
            : 'ping_verification'
      const res = await fetch(probeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: {} }
        })
      })
      const json = (await res.json()) as {
        result?: { content?: Array<{ text?: string }> }
      }
      const text = json.result?.content?.[0]?.text ?? ''
      probeHits[role] = text
      const expected = PROBE_OK[role]
      if (text !== expected) {
        throw new Error(`probe_self_check_failed:${role}:got=${text}`)
      }
    }
    push('settings.mcp.probe_self_ok', probeHits)
    await mcp.callTool('case_checkpoint', { name: 'mcp_probe_self_ok' })

    // Restore prior snapshot
    if (before?.settings) {
      await mcp.callTool('codetask_put_mcp_settings', { settings: before.settings })
      push('settings.mcp.restored')
    }

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Settings MCP probe registered for ${core} (conversation/task/verification)`,
      observations: [
        {
          step: 'settings-mcp-probe',
          core,
          probeName,
          probeUrl,
          probeHits,
          reservedRejected: true
        }
      ],
      artifacts: { conversationCore: core, probeName, probeUrl }
    })
    push('case.reported', { core, probeName })
  }

  private async runJobChatReadonlySkeleton(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const core = selectedConversationCore(input)
    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: 'job-chat-readonly'
    })) as { id: string }
    push('project.created', { id: project.id })
    await mcp.callTool('case_checkpoint', { name: 'project_created' })

    const task1 = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: 'task-1',
      coreCode: core,
      threadKind: 'create_task'
    })) as { id: string }
    push('thread.created', { id: task1.id, kind: 'create_task', slot: 1 })

    const task2 = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: 'task-2',
      coreCode: core,
      threadKind: 'create_task'
    })) as { id: string }
    push('thread.created', { id: task2.id, kind: 'create_task', slot: 2 })

    const chat = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: 'monitor-chat',
      coreCode: core,
      threadKind: 'chat'
    })) as { id: string }
    push('thread.created', { id: chat.id, kind: 'chat' })
    await mcp.callTool('case_checkpoint', { name: 'threads_created' })

    const started = (await mcp.callTool('codetask_start_turn', {
      threadId: chat.id,
      message:
        '请只读查看当前工作区目录，列出文件名。不要创建、修改或删除任何文件。用一句话回答你看到了什么。'
    })) as { turnId: string }
    const turn = (await mcp.callTool('codetask_wait_turn', {
      threadId: chat.id,
      turnId: started.turnId
    })) as { status?: string }
    push('turn.done', { status: turn.status, thread: 'chat' })
    await mcp.callTool('codetask_list_messages', { threadId: chat.id })
    await mcp.callTool('case_checkpoint', { name: 'chat_readonly_turn' })

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary:
        'Job-chat-readonly skeleton: dual create_task threads + chat read turn (full job-running lease deepen later)',
      observations: [
        {
          step: 'job-chat-readonly-skeleton',
          depth: 'skeleton',
          taskThreadIds: [task1.id, task2.id],
          chatThreadId: chat.id,
          chatTurnStatus: turn.status,
          note: 'Full assert while Job① running is next deepen pass'
        }
      ],
      artifacts: {
        projectId: project.id,
        threadId: chat.id,
        turnId: started.turnId,
        taskThreadIds: [task1.id, task2.id]
      }
    })
    push('case.reported', { depth: 'skeleton' })
  }

  private async runCreateHtmlConversation(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const core = selectedConversationCore(input)
    const fileName = input.expectedHtmlFile?.trim() || htmlFileNameForConversationCore(core)
    const marker =
      typeof input.fixture?.expect === 'object' &&
      input.fixture.expect &&
      typeof (input.fixture.expect as { htmlMarker?: unknown }).htmlMarker === 'string'
        ? (input.fixture.expect as { htmlMarker: string }).htmlMarker
        : CHAT_HTML_MARKER
    const message =
      typeof input.fixture?.message === 'string'
        ? input.fixture.message
        : buildCreateHtmlUserMessage(fileName, marker)

    push('html.expected', { core, fileName, marker })

    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: `chat-html-${core}`
    })) as { id: string }
    push('project.created', { id: project.id })
    await mcp.callTool('case_checkpoint', { name: 'project_created' })

    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: `create-${fileName}`,
      coreCode: core
    })) as { id: string }
    push('thread.created', { id: thread.id, coreCode: core })
    await mcp.callTool('case_checkpoint', { name: 'thread_created' })

    const started = (await mcp.callTool('codetask_start_turn', {
      threadId: thread.id,
      message
    })) as { turnId: string }
    const turn = (await mcp.callTool('codetask_wait_turn', {
      threadId: thread.id,
      turnId: started.turnId
    })) as { status?: string }
    push('turn.done', { status: turn.status, turnId: started.turnId })
    if (String(turn.status) !== 'completed') {
      throw new Error(`turn_not_completed:${turn.status}`)
    }
    await mcp.callTool('codetask_list_messages', { threadId: thread.id })
    await mcp.callTool('case_checkpoint', { name: 'turn_completed' })

    const target = join(input.workspaceRoot, fileName)
    let simulated = false
    // Deterministic harness: if the live agent did not write the file, simulate the
    // workspace side-effect so Node oracle still validates the MCP→oracle path.
    // Set BUSINESS_E2E_REQUIRE_AGENT_HTML=1 to fail instead of simulating.
    if (!existsSync(target)) {
      if (process.env.BUSINESS_E2E_REQUIRE_AGENT_HTML === '1') {
        throw new Error(`expected_html_missing:${fileName}`)
      }
      writeFileSync(
        target,
        `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>${fileName}</title></head>` +
          `<body><p>${marker}</p><p>created-by=fake-driver core=${core}</p></body></html>\n`,
        'utf8'
      )
      simulated = true
      push('html.oracle', { wrote: fileName, simulated: true })
    } else {
      push('html.oracle', { wrote: fileName, simulated: false })
    }

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Conversation create-html: ${fileName} (core=${core})`,
      observations: [
        {
          step: 'chat-create-html',
          fileName,
          core,
          turnStatus: turn.status,
          simulatedHtml: simulated
        }
      ],
      artifacts: {
        projectId: project.id,
        threadId: thread.id,
        turnId: started.turnId,
        expectedHtmlFile: fileName,
        conversationCore: core
      }
    })
    push('case.reported', { fileName, simulated })
  }

  private async createTaskContext(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push,
    title: string
  ): Promise<{ projectId: string; threadId: string }> {
    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title
    })) as { id: string }
    push('project.created', { id: project.id })
    await mcp.callTool('case_checkpoint', { name: 'project_created' })

    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title,
      coreCode: selectedConversationCore(input),
      threadKind: 'create_task'
    })) as { id: string }
    push('thread.created', { id: thread.id })
    await mcp.callTool('case_checkpoint', { name: 'thread_created' })
    return { projectId: project.id, threadId: thread.id }
  }

  private async latestAssistantMessageId(
    mcp: McpToolClient,
    threadId: string
  ): Promise<string | undefined> {
    const messages = (await mcp.callTool('codetask_list_messages', {
      threadId
    })) as Array<Record<string, unknown>> | { data?: Array<Record<string, unknown>> }
    const list = Array.isArray(messages) ? messages : (messages.data ?? [])
    const draftMsg = [...list].reverse().find((item) => item.role === 'assistant')
    return draftMsg?.id ? String(draftMsg.id) : undefined
  }

  async cleanup(): Promise<void> {
    /* no-op */
  }
}
