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
import { eq } from 'drizzle-orm'
import { getDb } from '../../src/server/db'
import { threadJobs } from '../../src/server/db/schema'
import { clearExecutionLease } from '../../src/server/jobs/repository'
import { abortActiveTurn } from '../../src/server/jobs/controls'
import {
  reconcileOrphanRunningJobsOnStartup,
  resetJobReconcileForTests
} from '../../src/server/jobs/reconcile'
import { saveControlPlanePolicies } from '../../src/server/settings/control-plane'
import { THREAD_KIND_CHAT, THREAD_KIND_CREATE_TASK } from '../../src/server/threads/types'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import {
  buildProposeTaskDraftArgs,
  buildRegisterPlanArgs,
  FIXTURE_TASK_CONTEXTS,
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

    this.ctx = bootstrapRuntime({ dataDir: this.dataDir })
    this.ctx.settings.patch((file) => {
      file.retention = {
        ...DEFAULT_RETENTION_SETTINGS,
        ...(typeof file.retention === 'object' && file.retention !== null
          ? (file.retention as Record<string, unknown>)
          : {}),
        compactCountersOnTerminal: false
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

    await saveControlPlanePolicies({
      plannerCoreCode: 'codex',
      sliceVerifierCoreCode: 'codex',
      milestoneVerifierCoreCode: 'opencode'
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

  async simulateServiceRestart(): Promise<void> {
    if (!this.server || !this.dataDir) {
      throw new Error('harness not set up')
    }
    const port =
      typeof this.server.address() === 'object' && this.server.address()
        ? (this.server.address() as { port: number }).port
        : 0

    const ctx = getAppContext()
    const db = getDb()
    const activeJobs = db
      .select({ id: threadJobs.id })
      .from(threadJobs)
      .where(eq(threadJobs.status, 'running'))
      .all()
    for (const row of activeJobs) {
      ctx.executionRuntime.setControl(row.id, 'paused')
      abortActiveTurn(row.id)
    }
    const drainDeadline = Date.now() + 10_000
    while (Date.now() < drainDeadline) {
      const stillRunning = activeJobs.some((row) => ctx.executionRuntime.isLoopActive(row.id))
      if (!stillRunning) break
      await sleep(50)
    }

    resetJobReconcileForTests()
    await resetAppContextForTests()
    this.ctx = bootstrapRuntime({ dataDir: this.dataDir })
    const restartedDb = getDb()
    const runningJobs = restartedDb
      .select({ id: threadJobs.id })
      .from(threadJobs)
      .where(eq(threadJobs.status, 'running'))
      .all()
    for (const row of runningJobs) {
      await clearExecutionLease(row.id)
    }
    await reconcileOrphanRunningJobsOnStartup()
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
    } catch {
      /* best-effort, ignore errors */
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

    const plannerCalls = [
      ...FIXTURE_TASK_CONTEXTS.map((ctx) => ({
        tool: 'register_task_context',
        args: { ...ctx }
      })),
      { tool: 'register_plan', args: buildRegisterPlanArgs() }
    ]
    this.registry.set('planner:0', { reply: 'plan registered', mcpCalls: plannerCalls })
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
      'Content-Type': 'application/json'
    }
  }

  private async setupAccount(): Promise<void> {
    const setup = await this.json<{ token: string; username: string }>('POST', '/api/setup', {
      username: TEST_USERNAME,
      password: TEST_PASSWORD
    })
    this.token = setup.token
    this.username = setup.username
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
      throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status} ${path}`)
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
    kind: typeof THREAD_KIND_CHAT | typeof THREAD_KIND_CREATE_TASK,
    coreCode: SupportedCoreCode = 'codex',
    title?: string
  ): Promise<{ id: string; coreCode: string; threadKind: string }> {
    if (!this.projectId) {
      await this.createProject()
    }
    return this.json('POST', `/api/projects/${this.projectId}/threads`, {
      title: title ?? (kind === THREAD_KIND_CREATE_TASK ? 'Create Task' : 'Chat'),
      coreCode,
      threadKind: kind
    })
  }

  async getThread(threadId: string): Promise<Record<string, unknown>> {
    return this.json('GET', `/api/threads/${threadId}`)
  }

  async listMessages(threadId: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.json<{ messages: Array<Record<string, unknown>> }>(
      'GET',
      `/api/threads/${threadId}/messages?limit=200`
    )
    return data.messages
  }

  async switchCore(threadId: string, coreCode: SupportedCoreCode): Promise<void> {
    await this.json('PATCH', `/api/threads/${threadId}/core`, { coreCode })
  }

  async sendMessage(
    threadId: string,
    message: string,
    options?: { createTaskMode?: boolean; generateDraft?: boolean; attachmentIds?: string[] }
  ): Promise<SseEvent[]> {
    const events: SseEvent[] = []
    const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        message,
        createTaskMode: options?.createTaskMode === true,
        generateDraft: options?.generateDraft === true,
        attachmentIds: options?.attachmentIds
      })
    })

    if (!response.ok || !response.body) {
      const text = await response.text()
      throw new Error(`SSE failed: ${response.status} ${text}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        const parsed = parseSseChunk(chunk)
        if (parsed) {
          events.push(parsed)
          if (parsed.event === 'done' || parsed.event === 'error') {
            await reader.cancel()
            return events
          }
        }
      }
    }
    return events
  }

  async sendMessageExpectError(
    threadId: string,
    message: string,
    options?: { createTaskMode?: boolean }
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

  async confirmDraftFinal(
    threadId: string,
    draftMessageId: string
  ): Promise<{ job: Record<string, unknown> }> {
    return this.json(
      'POST',
      `/api/threads/${threadId}/messages/${draftMessageId}/draft/confirm-final`,
      {}
    )
  }

  async confirmPlan(threadId: string, jobId: string): Promise<{ job: Record<string, unknown> }> {
    return this.json('POST', `/api/threads/${threadId}/jobs/${jobId}/confirm-plan`, {})
  }

  async confirmAllPlanNodes(threadId: string, designSessionId: string): Promise<void> {
    const job = await this.getThreadJob(threadId, designSessionId)
    const plan = job.plan as
      | {
          milestones?: Array<{ slices?: Array<{ tasks?: unknown[] }> }>
        }
      | undefined
    const milestones = plan?.milestones ?? []
    for (let mi = 0; mi < milestones.length; mi++) {
      const mRef = `m${mi + 1}`
      const slices = milestones[mi]?.slices ?? []
      for (let si = 0; si < slices.length; si++) {
        const sRef = `${mRef}-s${si + 1}`
        const tasks = slices[si]?.tasks ?? []
        for (let ti = 0; ti < tasks.length; ti++) {
          const nodeRef = `${sRef}-t${ti + 1}`
          await this.json(
            'POST',
            `/api/threads/${threadId}/jobs/${designSessionId}/plan/nodes/${encodeURIComponent(nodeRef)}/confirm`,
            {}
          )
        }
        await this.json(
          'POST',
          `/api/threads/${threadId}/jobs/${designSessionId}/plan/nodes/${encodeURIComponent(sRef)}/confirm`,
          {}
        )
      }
      await this.json(
        'POST',
        `/api/threads/${threadId}/jobs/${designSessionId}/plan/nodes/${encodeURIComponent(mRef)}/confirm`,
        {}
      )
    }
  }

  async getJob(jobId: string): Promise<Record<string, unknown>> {
    const data = await this.json<{ job: Record<string, unknown> }>('GET', `/api/jobs/${jobId}`)
    return data.job
  }

  async getThreadJob(threadId: string, jobId: string): Promise<Record<string, unknown>> {
    const data = await this.json<{ job: Record<string, unknown> }>(
      'GET',
      `/api/threads/${threadId}/jobs/${jobId}`
    )
    return data.job
  }

  async listThreadPlans(threadId: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.json<{ plans: Array<Record<string, unknown>> }>(
      'GET',
      `/api/threads/${threadId}/plans`
    )
    return data.plans
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
    const response = await fetch(`${this.baseUrl}/api/threads/${threadId}/attachments`, {
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

  async seedDraftReady(): Promise<{ threadId: string; draftMessageId: string }> {
    this.installDefaultCollectToPlanScripts()
    const thread = await this.createThread(THREAD_KIND_CREATE_TASK, 'codex')
    await this.sendMessage(thread.id, '我要做一个小型功能', { createTaskMode: true })
    await this.sendMessage(thread.id, '验收标准是 typecheck 通过', { createTaskMode: true })

    const messages = await this.listMessages(thread.id)
    const draft = this.findDraftMessage(messages)
    if (!draft?.id) throw new Error('draft not created')
    this.setDraftMessageId(String(draft.id))

    await this.sendMessage(thread.id, 'review draft', { createTaskMode: true })
    await this.sendMessage(thread.id, 'update draft', { createTaskMode: true })
    await this.sendMessage(thread.id, 'revise contract', { createTaskMode: true })
    await this.sendMessage(thread.id, 'confirm contract', { createTaskMode: true })

    return { threadId: thread.id, draftMessageId: this.draftMessageId }
  }

  async startPlanningJob(options?: { plannerScript?: FakeTurnScript }): Promise<{
    threadId: string
    draftMessageId: string
    jobId: string
  }> {
    if (options?.plannerScript) {
      this.registry.set('planner:0', options.plannerScript)
    }
    const draft = await this.seedDraftReady()
    const { job } = await this.confirmDraftFinal(draft.threadId, draft.draftMessageId)
    return { threadId: draft.threadId, draftMessageId: draft.draftMessageId, jobId: String(job.id) }
  }

  async seedPlanReady(options?: { plannerScript?: FakeTurnScript }): Promise<{
    threadId: string
    draftMessageId: string
    jobId: string
  }> {
    const started = await this.startPlanningJob(options)
    await this.waitForJob(started.jobId, (j) => j.status === 'plan_editing', 60_000)
    await this.confirmAllPlanNodes(started.threadId, started.jobId)
    return started
  }

  async seedConfirmedPlan(): Promise<{
    threadId: string
    draftMessageId: string
    jobId: string
  }> {
    const seeded = await this.seedPlanReady()
    const { job } = await this.confirmPlan(seeded.threadId, seeded.jobId)
    return { ...seeded, jobId: String(job.id) }
  }

  async runHappyPathExecution(): Promise<Record<string, unknown>> {
    this.installDefaultExecutionScripts()
    const seeded = await this.seedPlanReady()
    const { job } = await this.confirmPlan(seeded.threadId, seeded.jobId)
    return this.waitForJob(String(job.id), (job) => job.status === 'completed', 120_000)
  }
}

function parseSseChunk(chunk: string): SseEvent | null {
  const lines = chunk.split('\n')
  let event = 'message'
  let data = ''
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (!data) return null
  try {
    return { event, data: JSON.parse(data) as Record<string, unknown> }
  } catch {
    return { event, data: { raw: data } }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { SUPPORTED_CORE_CODES, THREAD_KIND_CHAT, THREAD_KIND_CREATE_TASK }
