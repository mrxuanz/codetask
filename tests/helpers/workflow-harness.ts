import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import {
  bootstrapRuntime,
  createApp,
  getAppContext,
  resetAppContextForTests,
  type AppContext
} from '../../src/server/index'
import { initConversationMcpBackend } from '../../src/server/conversation/mcp/url'
import {
  resetCoreAvailabilityStubForTests,
  setCoreAvailabilityStubForTests,
  SUPPORTED_CORE_CODES,
  type SupportedCoreCode
} from '../../src/server/conversation/cores'
import {
  resetTestAgentTurnProviders,
  setTaskEvidenceWaitTimeoutForTests,
  setTestAgentTurnProviders
} from '../../src/server/agent-runtime/providers/test-overrides'
import { getOrComposeExecution } from '../../src/server/design-module'
import { getOrComposeSettings } from '../../src/server/settings/service'
import { THREAD_KIND_CHAT } from '../../src/shared/contracts/threads.ts'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import {
  buildProposeTaskDraftArgs,
  FIXTURE_TASK_EVIDENCE,
  FIXTURE_SLICE_VERDICT_PASSED,
  FIXTURE_MILESTONE_VERDICT_PASSED
} from './fixtures'
import {
  FakeScriptRegistry,
  registerFakeProviders,
  type FakeTurnScript
} from './fake-agent-provider'

const TEST_USERNAME = 'workflow-test'
const TEST_PASSWORD = 'Workflow-test1!'

export interface SseEvent {
  event: string
  data: Record<string, unknown>
}

export class WorkflowHarness {
  readonly registry = new FakeScriptRegistry()
  dataDir = ''
  workspaceRoot = ''
  baseUrl = ''
  token = ''
  username = TEST_USERNAME
  projectId = ''
  private server: ServerType | null = null
  private ctx: AppContext | null = null
  private draftMessageId: string | null = null

  async setup(): Promise<void> {
    await resetAppContextForTests()
    resetTestAgentTurnProviders()
    resetCoreAvailabilityStubForTests()
    this.registry.reset()

    this.dataDir = mkdtempSync(join(tmpdir(), 'codetask-workflow-'))
    this.workspaceRoot = join(this.dataDir, 'workspace')
    mkdirSync(this.workspaceRoot, { recursive: true })
    try {
      this.workspaceRoot = realpathSync.native(this.workspaceRoot)
    } catch {
      this.workspaceRoot = realpathSync(this.workspaceRoot)
    }

    this.ctx = bootstrapRuntime({
      dataDir: this.dataDir,
      config: {
        retention: {
          ...DEFAULT_RETENTION_SETTINGS,
          compactCountersOnTerminal: false
        }
      }
    })
    const app = createApp(this.ctx, { isDev: false })
    this.server = await this.listen(app)

    const address = this.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    this.baseUrl = `http://127.0.0.1:${port}`
    initConversationMcpBackend(port)

    setCoreAvailabilityStubForTests((code) => ({
      code,
      label: code,
      description: 'workflow test stub',
      available: true,
      detectedCommand: code,
      launchCommand: code,
      executablePath: join(this.dataDir, 'bin', code)
    }))

    this.wireFakeAgents()
    setTaskEvidenceWaitTimeoutForTests(3_000)

    const settingsApp = getOrComposeSettings(this.ctx).app
    const agentDefaults = settingsApp.getAgentDefaults()
    await settingsApp.updateAgentDefaults(agentDefaults.revision, {
      plannerProvider: 'codex',
      sliceVerifierProvider: 'codex',
      milestoneVerifierProvider: 'opencode'
    })

    await this.setupAccount()
  }

  async teardown(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => (error ? reject(error) : resolve()))
      })
      this.server = null
    }
    resetTestAgentTurnProviders()
    setTaskEvidenceWaitTimeoutForTests(undefined)
    resetCoreAvailabilityStubForTests()
    await resetAppContextForTests()
    if (this.dataDir) {
      try {
        rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        /* best-effort, ignore errors */
      }
      this.dataDir = ''
    }
  }

  async waitForExecutionIdle(jobId: string, timeoutMs = 60_000): Promise<void> {
    const ctx = getAppContext()
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (!ctx.executionRuntime.isLoopActive(jobId)) return
      await sleep(50)
    }
    throw new Error(`waitForExecutionIdle timeout: jobId=${jobId}`)
  }

  async simulateServiceRestart(): Promise<void> {
    if (!this.server || !this.dataDir) {
      throw new Error('harness not set up')
    }
    const port =
      typeof this.server.address() === 'object' && this.server.address()
        ? (this.server.address() as { port: number }).port
        : 0

    const ctx = getAppContext()
    ctx.executionRuntime.dropAll()
    const execution = getOrComposeExecution(ctx)
    execution.drain()

    await resetAppContextForTests()
    this.ctx = bootstrapRuntime({ dataDir: this.dataDir })
    // Wire test doubles before startup reconcile: running jobs may auto-resume
    // immediately, and must not execute against unbound agent providers.
    initConversationMcpBackend(port)
    setCoreAvailabilityStubForTests((code) => ({
      code,
      label: code,
      description: 'workflow test stub',
      available: true,
      detectedCommand: code,
      launchCommand: code,
      executablePath: join(this.dataDir, 'bin', code)
    }))
    this.wireFakeAgents()
    setTaskEvidenceWaitTimeoutForTests(3_000)
    getOrComposeExecution(getAppContext()).startup()
  }

  private wireFakeAgents(): void {
    setTestAgentTurnProviders(registerFakeProviders(this.registry))
    this.registry.setArgResolver((tool, args) => {
      if (tool === 'confirm_requirements_contract' && !args.messageId && this.draftMessageId) {
        return { ...args, messageId: this.draftMessageId }
      }
      if (tool === 'revise_requirements_contract' && this.draftMessageId) {
        return { ...args, messageId: this.draftMessageId }
      }
      if (tool === 'confirm_draft_section' && !args.messageId && this.draftMessageId) {
        return { ...args, messageId: this.draftMessageId }
      }
      return args
    })
  }

  setDraftMessageId(draftMessageId: string): void {
    this.draftMessageId = draftMessageId
  }

  getDraftMessageId(): string | null {
    return this.draftMessageId
  }

  resetScripts(): void {
    this.registry.reset()
    this.draftMessageId = null
    this.wireFakeAgents()
  }

  async drainActiveJobs(): Promise<void> {
    try {
      const data = await this.json<{ jobs: Array<{ id: string; status: string }> }>(
        'GET',
        '/api/jobs?limit=50'
      )
      for (const job of data.jobs ?? []) {
        if (!['completed', 'failed', 'cancelled'].includes(String(job.status))) {
          await this.cancelJob(String(job.id)).catch(() => undefined)
        }
      }
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const again = await this.json<{ jobs: Array<{ id: string; status: string }> }>(
          'GET',
          '/api/jobs?limit=50'
        )
        const active = (again.jobs ?? []).filter(
          (job) => !['completed', 'failed', 'cancelled', 'paused'].includes(String(job.status))
        )
        if (active.length === 0) break
        await sleep(100)
      }
    } catch {
      /* best-effort, ignore errors */
    }
    try {
      const { releaseAllActiveWorkspaceLeases } =
        await import('../../src/server/infra/workspace-lease-store')
      releaseAllActiveWorkspaceLeases()
    } catch {
      /* best-effort */
    }
    try {
      getOrComposeExecution(getAppContext()).drain()
    } catch {
      /* best-effort */
    }
  }

  setScript(key: string, script: FakeTurnScript): void {
    this.registry.set(key, script)
  }

  setVerifierOutcome(sliceId: string, attempt: number, verdict: Record<string, unknown>): void {
    this.registry.set(`slice-verifier:${sliceId}:${attempt}`, {
      reply: `verifier ${sliceId} attempt ${attempt}`,
      mcpCalls: [{ tool: 'complete_slice_verification', args: verdict }]
    })
  }

  setMilestoneVerifierOutcome(
    milestoneId: string,
    attempt: number,
    verdict: Record<string, unknown>
  ): void {
    this.registry.set(`milestone-verifier:${milestoneId}:${attempt}`, {
      reply: `milestone verifier ${milestoneId}`,
      mcpCalls: [{ tool: 'complete_milestone_verification', args: verdict }]
    })
  }

  installDefaultCollectToPlanScripts(): void {
    this.registry.set('conversation:collect:codex:1', {
      reply: '请补充验收标准',
      mcpCalls: []
    })
    this.registry.set('conversation:collect:codex:2', {
      reply: '生成草案',
      mcpCalls: [{ tool: 'propose_task_draft', args: buildProposeTaskDraftArgs() }]
    })

    const draftReview = (turn: number, calls: FakeTurnScript['mcpCalls']): void => {
      this.registry.set(`conversation:draft_review:codex:${turn}`, {
        reply: `draft review ${turn}`,
        mcpCalls: calls
      })
    }

    draftReview(1, [{ tool: 'get_task_draft', args: {} }])
    draftReview(2, [
      {
        tool: 'update_task_draft',
        args: { title: '小型功能', summary: '更新后的摘要说明' }
      }
    ])
    draftReview(3, [
      {
        tool: 'revise_requirements_contract',
        args: {
          revision: 2,
          requirementsContractMarkdown: '# REQUIREMENTS CONTRACT\n\nUpdated contract body.'
        }
      }
    ])
    draftReview(4, [{ tool: 'confirm_requirements_contract', args: {} }])

    // Design planning commits via PlanningApplicationPort; no Planner HTTP MCP.
    this.registry.set('planner:0', { reply: 'plan registered', mcpCalls: [] })
  }

  installDefaultExecutionScripts(): void {
    const workerScript = {
      reply: 'task done',
      mcpCalls: [{ tool: 'report_task_result', args: { ...FIXTURE_TASK_EVIDENCE } }]
    }
    this.registry.setDefaultTaskWorkerScript(workerScript)
    for (const taskId of ['m1-s1-t1', 'm1-s2-t1', 'm1-s2-t2']) {
      this.registry.set(`task-worker:${taskId}`, workerScript)
    }
    this.setVerifierOutcome('m1-s1', 0, FIXTURE_SLICE_VERDICT_PASSED)
    this.setVerifierOutcome('m1-s2', 0, FIXTURE_SLICE_VERDICT_PASSED)
    this.setMilestoneVerifierOutcome('m1', 0, FIXTURE_MILESTONE_VERDICT_PASSED)
  }

  private async listen(app: ReturnType<typeof createApp>): Promise<ServerType> {
    return new Promise((resolve, reject) => {
      const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
      server.once('listening', () => resolve(server))
      server.once('error', reject)
    })
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'x-codetask-auth-transport': 'bearer',
      'Content-Type': 'application/json'
    }
  }

  private async setupAccount(): Promise<void> {
    const setup = await this.json<{
      token: string
      actor?: { username: string }
      username?: string
    }>('POST', '/api/auth/setup', {
      username: TEST_USERNAME,
      password: TEST_PASSWORD
    })
    this.token = setup.token
    this.username = setup.actor?.username ?? setup.username ?? TEST_USERNAME
  }

  async json<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...init
    })
    const payload = (await response.json()) as {
      success?: boolean
      data?: T
      message?: string
      error?: string
    }
    if (!response.ok || payload.success === false) {
      const detail =
        typeof payload.message === 'string'
          ? payload.message
          : typeof payload.error === 'string'
            ? payload.error
            : JSON.stringify(payload.error ?? payload)
      throw new Error(detail || `HTTP ${response.status} ${path}`)
    }
    return payload.data as T
  }

  async createProject(
    title = 'Workflow Test Project'
  ): Promise<{ id: string; workspaceRoot: string }> {
    const row = await this.json<{ id: string; workspaceRoot: string }>('POST', '/api/projects', {
      workspaceRoot: this.workspaceRoot,
      title,
      createIfMissing: true
    })
    this.projectId = row.id
    return row
  }

  async createThread(
    kind: typeof THREAD_KIND_CHAT = THREAD_KIND_CHAT,
    coreCode: SupportedCoreCode = 'codex',
    title?: string
  ): Promise<{ id: string; coreCode: string; threadKind: string }> {
    if (!this.projectId) {
      await this.createProject()
    }
    const providerCode =
      coreCode === 'claude-code'
        ? 'claude'
        : coreCode === 'cursorcli'
          ? 'cursor'
          : coreCode
    const created = await this.json<{ id: string; providerCode: string }>(
      'POST',
      `/api/projects/${this.projectId}/conversations`,
      {
        title: title ?? 'Chat',
        providerCode
      }
    )
    return {
      id: created.id,
      coreCode: created.providerCode,
      threadKind: THREAD_KIND_CHAT
    }
  }

  async getThread(threadId: string): Promise<Record<string, unknown>> {
    return this.json('GET', `/api/conversations/${threadId}`)
  }

  async listMessages(threadId: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.json<Array<Record<string, unknown>> | { messages: Array<Record<string, unknown>> }>(
      'GET',
      `/api/conversations/${threadId}/messages`
    )
    return Array.isArray(data) ? data : data.messages
  }

  async switchCore(threadId: string, coreCode: SupportedCoreCode): Promise<void> {
    const providerCode =
      coreCode === 'claude-code'
        ? 'claude'
        : coreCode === 'cursorcli'
          ? 'cursor'
          : coreCode
    await this.json('PATCH', `/api/conversations/${threadId}/provider`, { providerCode })
  }

  private async enqueueTurnAndWait(
    threadId: string,
    message: string,
    options?: { createTaskMode?: boolean; generateDraft?: boolean; attachmentIds?: string[] }
  ): Promise<Record<string, unknown>> {
    if (options?.createTaskMode || options?.generateDraft) {
      const response = await fetch(`${this.baseUrl}/api/conversations/${threadId}/turns`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          message,
          createTaskMode: options.createTaskMode === true,
          generateDraft: options.generateDraft === true,
          attachmentIds: options.attachmentIds ?? [],
          idempotencyKey: `wf-${Date.now()}-${Math.random()}`
        })
      })
      const payload = (await response.json()) as {
        success?: boolean
        error?: { code?: string; message?: string }
        message?: string
      }
      const code = payload.error?.code ?? null
      throw Object.assign(new Error(payload.error?.message ?? payload.message ?? 'rejected'), {
        httpStatus: response.status,
        code
      })
    }
    const accepted = await this.json<{ turnId: string }>(
      'POST',
      `/api/conversations/${threadId}/turns`,
      {
        message,
        attachmentIds: options?.attachmentIds ?? [],
        idempotencyKey: `wf-${Date.now()}-${Math.random()}`
      }
    )
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const turn = await this.json<Record<string, unknown>>(
        'GET',
        `/api/conversations/${threadId}/turns/${accepted.turnId}`
      )
      const status = String(turn.status ?? '')
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        return { ...turn, id: turn.id ?? accepted.turnId }
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Turn ${accepted.turnId} did not settle`)
  }

  async postMessageExpectHttpError(
    threadId: string,
    message: string,
    options?: { createTaskMode?: boolean; generateDraft?: boolean }
  ): Promise<{ httpStatus: number; code: string | null; message?: string }> {
    try {
      await this.enqueueTurnAndWait(threadId, message, options)
      return { httpStatus: 200, code: null }
    } catch (error) {
      const err = error as { httpStatus?: number; code?: string | null; message?: string }
      return {
        httpStatus: err.httpStatus ?? 500,
        code: err.code ?? null,
        message: err.message
      }
    }
  }

  async sendMessage(
    threadId: string,
    message: string,
    options?: { createTaskMode?: boolean; generateDraft?: boolean; attachmentIds?: string[] }
  ): Promise<SseEvent[]> {
    const beforeIds = new Set((await this.listMessages(threadId)).map((item) => String(item.id)))
    const turn = await this.enqueueTurnAndWait(threadId, message, options)
    if (turn.status === 'failed' || turn.status === 'cancelled') {
      const error = (turn.lastError ?? turn.lastErrorJson ?? {}) as Record<string, unknown>
      const parsed =
        typeof error === 'string'
          ? (() => {
              try {
                return JSON.parse(error) as Record<string, unknown>
              } catch {
                return { message: error }
              }
            })()
          : error
      return [
        {
          event: 'error',
          data: {
            message: String(parsed.message ?? 'turn failed'),
            error: parsed
          }
        }
      ]
    }

    const events: SseEvent[] = []
    for (const item of await this.listMessages(threadId)) {
      if (beforeIds.has(String(item.id))) continue
      if (item.role === 'user') {
        events.push({ event: 'user_message', data: { message: item } })
      } else if (item.role === 'assistant') {
        events.push({ event: 'assistant_message', data: { message: item } })
      }
    }
    events.push({ event: 'done', data: { turnId: turn.id } })
    return events
  }

  async sendMessageExpectError(
    threadId: string,
    message: string,
    options?: { createTaskMode?: boolean; generateDraft?: boolean }
  ): Promise<{ message: string; code: string | null }> {
    const events = await this.sendMessage(threadId, message, options)
    const errorEvent = events.find((item) => item.event === 'error')
    const data = errorEvent?.data as { message?: string; error?: { code?: string } } | undefined
    return {
      message: String(data?.message ?? 'no error event'),
      code: data?.error?.code ?? null
    }
  }

  async jsonExpectError(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ message: string; code: string | null }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const payload = (await response.json()) as {
      message?: string
      error?: string
      data?: { turnErrorCode?: string; error?: { code?: string } }
    }
    return {
      message: payload.message ?? payload.error ?? `HTTP ${response.status}`,
      code: payload.data?.turnErrorCode ?? payload.data?.error?.code ?? null
    }
  }

  findDraftMessage(messages: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
    return messages.find((msg) => msg.kind === 'task-launch-draft')
  }

  async getJob(jobId: string): Promise<Record<string, unknown>> {
    const data = await this.json<{ job: Record<string, unknown> }>('GET', `/api/jobs/${jobId}`)
    return data.job
  }


  async pauseJob(jobId: string): Promise<Record<string, unknown>> {
    const data = await this.json<{ job: Record<string, unknown> }>(
      'POST',
      `/api/jobs/${jobId}/pause`,
      {}
    )
    return data.job
  }

  async resumeJob(jobId: string): Promise<Record<string, unknown>> {
    const data = await this.json<{ job: Record<string, unknown> }>(
      'POST',
      `/api/jobs/${jobId}/resume`,
      {}
    )
    return data.job
  }

  async cancelJob(jobId: string): Promise<Record<string, unknown>> {
    const data = await this.json<{ job: Record<string, unknown> }>(
      'POST',
      `/api/jobs/${jobId}/cancel`,
      {}
    )
    return data.job
  }

  async uploadAttachment(
    threadId: string,
    name: string,
    content: string,
    mimeType = 'text/markdown'
  ): Promise<{ id: string; name: string }> {
    const form = new FormData()
    form.append('file', new Blob([content], { type: mimeType }), name)
    const response = await fetch(`${this.baseUrl}/api/conversations/${threadId}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form
    })
    const payload = (await response.json()) as {
      success?: boolean
      data?: { attachment: { id: string; name: string } }
      message?: string
    }
    if (!response.ok || payload.success === false || !payload.data?.attachment) {
      throw new Error(payload.message ?? `upload failed ${response.status}`)
    }
    return payload.data.attachment
  }

  async waitForJob(
    jobId: string,
    predicate: (job: Record<string, unknown>) => boolean,
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const job = await this.getJob(jobId)
      if (predicate(job)) return job
      await sleep(100)
    }
    const last = await this.getJob(jobId)
    throw new Error(
      `waitForJob timeout: status=${String(last.status)} phase=${String((last.taskProgress as Record<string, unknown>)?.phase)}`
    )
  }

}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { SUPPORTED_CORE_CODES, THREAD_KIND_CHAT }
