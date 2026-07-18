import { existsSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { eq, isNull, and, like } from 'drizzle-orm'
import { getDb } from '../../src/server/db'
import { authState, designSessions, threads } from '../../src/server/db/schema'
import { createProject } from '../../src/server/projects/service'
import { createThread } from '../../src/server/threads/service'
import { THREAD_KIND_CREATE_TASK } from '../../src/server/threads/types'
import { insertMessage } from '../../src/server/conversation/messages'
import {
  saveDesignAbilities,
  saveDesignPlan,
  saveDesignPlanProgress
} from '../../src/server/db/design-plan'
import { buildManifestFromCorpus } from '../../src/server/reference-corpus/service'
import { serializeJobReferenceManifest } from '../../src/server/legacy-control-plane/reference-manifest'
import { defaultTaskProgress } from '../../src/server/planner/save-plan'
import type { SavedJobPlan } from '../../src/server/planner/plan-types'
import type { SupportedCoreCode } from '../../src/server/conversation/cores'
import {
  TASK_LAUNCH_ABILITY_CATALOG,
  type TaskLaunchDraftAbility,
  type TaskLaunchDraftPayload
} from '../../src/server/conversation/draft/types'
import { buildPlanSummary } from '../../src/shared/plan-mutations'
import { launchJobFromDesignSession } from '../../src/server/design-session/service'

export const ALL_CORES: SupportedCoreCode[] = ['codex', 'claude-code', 'opencode', 'cursorcli']

export const CORE_LABELS: Record<SupportedCoreCode, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  cursorcli: 'Cursor CLI'
}

const CORE_ALIASES: Record<string, SupportedCoreCode> = {
  codex: 'codex',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  claude_code: 'claude-code',
  open: 'opencode',
  opencode: 'opencode',
  cursor: 'cursorcli',
  cursorcli: 'cursorcli',
  'cursor-cli': 'cursorcli',
  cursor_cli: 'cursorcli'
}

export const ABILITY_CODES = [
  'project-setup',
  'scaffolding',
  'frontend-implementation',
  'testing-validation'
] as const

const moduleDir = dirname(fileURLToPath(import.meta.url))
const scriptsDir = join(moduleDir, '..')
const projectRoot = join(scriptsDir, '..')
const fixturesDir = join(scriptsDir, 'fixtures')

export const WORKSPACE_PLACEHOLDER = '{{WORKSPACE}}'

export const BLOG_TITLE = 'CLI smoke test'
export const BLOG_SUMMARY =
  '快速 smoke：在工作区根目录创建 SMOKE.txt，内容为 ok，用于验证 CLI 执行与队列。'

export const ADJECTIVES = ['swift', 'calm', 'bright', 'quiet', 'bold', 'neat', 'clear', 'plain']
export const NOUNS = ['harbor', 'field', 'ridge', 'grove', 'forge', 'beam', 'delta', 'plain']

/** Repo root — resolved from this module, not process.cwd(). */
export function resolveProjectRoot(): string {
  return projectRoot
}

/** App data directory (app.db, settings.json, …). */
export function resolveProjectDataDir(): string {
  return join(projectRoot, 'data')
}

function resolvePlanTemplatePath(): string {
  const jsonPath = join(fixturesDir, 'cli-benchmark-plan.json')
  if (existsSync(jsonPath)) return jsonPath

  const gzPath = join(fixturesDir, 'cli-benchmark-plan.json.gz')
  if (existsSync(gzPath)) return gzPath

  throw new Error(
    `Missing CLI benchmark plan template. Expected one of:\n` + `  ${jsonPath}\n` + `  ${gzPath}`
  )
}

export interface AuthInfo {
  username: string
  sessionToken: string
}

export interface SeededSession {
  coreCode: SupportedCoreCode | 'mixed'
  workspacePath: string
  folderName: string
  threadId: string
  designSessionId: string
  projectId: string
}

export function parseCoreList(raw?: string): SupportedCoreCode[] {
  if (!raw?.trim()) return [...ALL_CORES]

  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)

  if (parts.length === 0) return [...ALL_CORES]

  const selected: SupportedCoreCode[] = []
  for (const part of parts) {
    const code = CORE_ALIASES[part]
    if (!code) {
      throw new Error(`未知 CLI: "${part}"。可用别名: codex, claude, open/opencode, cursor`)
    }
    if (!selected.includes(code)) selected.push(code)
  }
  return selected
}

export function readCoresArg(argv: string[]): SupportedCoreCode[] | undefined {
  const flagIdx = argv.indexOf('--cores')
  if (flagIdx >= 0) {
    return parseCoreList(argv[flagIdx + 1])
  }

  const inline = argv.find((arg) => arg.startsWith('--cores='))
  if (inline) {
    return parseCoreList(inline.slice('--cores='.length))
  }

  return undefined
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function randomDirName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!
  return `${adj}-${noun}-${randomUUID().slice(0, 4)}`
}

export function loadTemplatePlan(): SavedJobPlan {
  const templatePath = resolvePlanTemplatePath()
  const file = readFileSync(templatePath)
  const raw = templatePath.endsWith('.gz') ? gunzipSync(file) : file
  return JSON.parse(raw.toString('utf8')) as SavedJobPlan
}

export function buildAbilities(
  coreCode: SupportedCoreCode,
  reasonPrefix = 'CLI benchmark'
): TaskLaunchDraftAbility[] {
  return ABILITY_CODES.map((code) => {
    const item = TASK_LAUNCH_ABILITY_CATALOG.find((entry) => entry.code === code)
    if (!item) throw new Error(`Missing ability catalog entry: ${code}`)
    return {
      abilityCode: code,
      label: item.label,
      description: item.description,
      reason: `${reasonPrefix}: ${CORE_LABELS[coreCode]}`,
      recommendedCoreCode: coreCode
    }
  })
}

export function buildMixedAbilities(coreRotation: SupportedCoreCode[]): TaskLaunchDraftAbility[] {
  return ABILITY_CODES.map((code, index) => {
    const item = TASK_LAUNCH_ABILITY_CATALOG.find((entry) => entry.code === code)
    if (!item) throw new Error(`Missing ability catalog entry: ${code}`)
    const coreCode = coreRotation[index % coreRotation.length]!
    return {
      abilityCode: code,
      label: item.label,
      description: item.description,
      reason: `混合 CLI 轮换: 能力默认 ${CORE_LABELS[coreCode]}（以任务 coreCode 为准）`,
      recommendedCoreCode: coreCode
    }
  })
}

export function buildDraftPayload(input: {
  workspacePath: string
  titleSuffix: string
  draftMessageId: string
  designSessionId: string
  abilities: TaskLaunchDraftAbility[]
  summaryExtra?: string
}): TaskLaunchDraftPayload {
  const confirmedAt = new Date().toISOString()
  return {
    draftId: `draft-${randomUUID()}`,
    sourceMessageId: input.draftMessageId,
    title: `${BLOG_TITLE} (${input.titleSuffix})`,
    summary: input.summaryExtra ? `${BLOG_SUMMARY} ${input.summaryExtra}` : BLOG_SUMMARY,
    userFlow: '执行单个任务，在工作区创建 SMOKE.txt。',
    techStack: '无框架，仅文件写入',
    nfr: ['尽快完成'],
    acceptance: [
      { id: 'ac-1', given: '空工作区', when: '任务执行完成', then: 'SMOKE.txt 存在且内容为 ok' }
    ],
    verification: [{ command: 'type SMOKE.txt', appliesTo: 'all' }],
    outOfScope: ['框架初始化', '依赖安装', '多文件改动'],
    assumptions: ['空工作区'],
    requirementsContract: {
      markdown: `# REQUIREMENTS CONTRACT\n\n${BLOG_SUMMARY}`,
      status: 'confirmed',
      confirmedAt
    },
    workspacePath: input.workspacePath,
    status: 'confirmed',
    linkedPlanId: input.designSessionId,
    lockedSections: {
      requirementsContract: true,
      abilities: true,
      references: true,
      acceptance: true,
      userFlow: true,
      techStack: true
    },
    abilities: input.abilities,
    references: [],
    sourceAttachments: [],
    revision: 1
  }
}

export function markPlanFullyConfirmed(plan: SavedJobPlan): SavedJobPlan {
  return {
    ...plan,
    milestones: plan.milestones.map((milestone) => ({
      ...milestone,
      confirmed: true,
      slices: milestone.slices.map((slice) => ({
        ...slice,
        confirmed: true,
        tasks: slice.tasks.map((task) => ({ ...task, confirmed: true }))
      }))
    })),
    tasks: plan.tasks.map((task) => ({ ...task, confirmed: true }))
  }
}

function replaceWorkspaceInContext(contextMarkdown: string, workspacePath: string): string {
  return contextMarkdown.split(WORKSPACE_PLACEHOLDER).join(workspacePath)
}

export function clonePlanForUniformCore(
  template: SavedJobPlan,
  coreCode: SupportedCoreCode,
  workspacePath: string
): SavedJobPlan {
  const tasks = template.tasks.map((task) => ({
    ...task,
    coreCode,
    contextMarkdown: replaceWorkspaceInContext(task.contextMarkdown, workspacePath)
  }))

  const milestones = template.milestones.map((milestone) => ({
    ...milestone,
    slices: milestone.slices.map((slice) => ({
      ...slice,
      tasks: slice.tasks.map((task) => ({ ...task }))
    }))
  }))

  return markPlanFullyConfirmed({ milestones, tasks })
}

export function clonePlanWithRotatingCores(
  template: SavedJobPlan,
  coreRotation: SupportedCoreCode[],
  workspacePath: string
): SavedJobPlan {
  const tasks = template.tasks.map((task, index) => ({
    ...task,
    coreCode: coreRotation[index % coreRotation.length],
    contextMarkdown: replaceWorkspaceInContext(task.contextMarkdown, workspacePath)
  }))

  const milestones = template.milestones.map((milestone) => ({
    ...milestone,
    slices: milestone.slices.map((slice) => ({
      ...slice,
      tasks: slice.tasks.map((task) => ({ ...task }))
    }))
  }))

  return markPlanFullyConfirmed({ milestones, tasks })
}

export function formatCoreRotation(coreRotation: SupportedCoreCode[]): string {
  return coreRotation.map((code) => CORE_LABELS[code]).join(' → ')
}

export function describeTaskCoreAssignment(plan: SavedJobPlan): string {
  return plan.tasks
    .map((task) => `${task.id}: ${CORE_LABELS[(task.coreCode ?? 'codex') as SupportedCoreCode]}`)
    .join(', ')
}

export async function readAuth(): Promise<AuthInfo> {
  const db = getDb()
  const rows = await db.select().from(authState).limit(1)
  const row = rows[0]
  if (!row?.username || !row.sessionToken) {
    throw new Error('No authenticated user in auth_state. Log in via the app first.')
  }
  return { username: row.username, sessionToken: row.sessionToken }
}

const DEFAULT_SERVER_PORTS = [8080, 3000] as const

/** Ask the running dev:serve process to reconcile orphans and advance the queue. */
export async function kickServerJobQueue(auth: AuthInfo): Promise<boolean> {
  for (const port of DEFAULT_SERVER_PORTS) {
    const url = `http://127.0.0.1:${port}/api/jobs/queue/resume`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.sessionToken}` }
      })
      if (response.ok) return true
      const text = await response.text()
      console.warn(
        `Server queue kick failed on :${port} (${response.status}): ${text.slice(0, 200)}`
      )
    } catch {
      // try next port
    }
  }
  console.warn(
    'Server not reachable on ports 8080/3000. Jobs remain pending until dev:serve restarts or advances the queue.'
  )
  return false
}

export async function seedDesignSession(input: {
  username: string
  workspacePath: string
  folderName: string
  threadCoreCode: SupportedCoreCode
  threadTitle: string
  projectTitle: string
  sessionCoreLabel: SupportedCoreCode | 'mixed'
  buildPlan: () => SavedJobPlan
  buildDraftPayload: (ids: {
    draftMessageId: string
    designSessionId: string
  }) => TaskLaunchDraftPayload
}): Promise<SeededSession> {
  const project = await createProject(input.username, input.workspacePath, input.projectTitle, true)

  const thread = await createThread(
    input.username,
    project.id,
    input.threadTitle,
    input.threadCoreCode,
    THREAD_KIND_CREATE_TASK
  )

  const draftMessageId = `msg-${randomUUID()}`
  const designSessionId = `ds-${randomUUID()}`
  const confirmedAt = nowSec()
  const plan = input.buildPlan()
  const draftPayload = input.buildDraftPayload({ draftMessageId, designSessionId })
  const counts = buildPlanSummary(plan)

  await insertMessage({
    id: draftMessageId,
    threadId: thread.id,
    username: input.username,
    role: 'assistant',
    kind: 'task-launch-draft',
    content: draftPayload.title,
    coreCode: input.threadCoreCode,
    conversationId: thread.conversationId,
    payload: draftPayload,
    wizardPhase: 'ready_to_launch'
  })

  const manifest = buildManifestFromCorpus({
    designSessionId,
    draftMessageId,
    threadId: thread.id,
    workspaceRoot: input.workspacePath,
    corpus: [],
    manifestRevision: 1
  })

  const db = getDb()
  await db.insert(designSessions).values({
    id: designSessionId,
    threadId: thread.id,
    username: input.username,
    draftMessageId,
    title: draftPayload.title,
    summary: draftPayload.summary,
    workspaceRoot: input.workspacePath,
    phase: 'ready_to_launch',
    draftRevision: draftPayload.revision ?? 1,
    planRevision: 1,
    status: 'plan_editing',
    planPhase: 'plan_ready',
    planStatus: 'completed',
    planContextsRegistered: counts.tasks,
    planContextsTotal: counts.tasks,
    planMessage: `计划已生成：${counts.tasks} 个步骤，请审阅后确认`,
    planCountsJson: JSON.stringify(counts),
    taskPhase: 'idle',
    taskStatus: 'pending',
    taskCurrentIndex: 0,
    taskTotal: counts.tasks,
    taskCurrentTaskId: null,
    taskMessage: null,
    taskMetaJson: '{}',
    referenceManifestJson: serializeJobReferenceManifest(manifest),
    manifestRevision: 1,
    corpusRevision: 1,
    frozenCorpusRevision: 1,
    draftConfirmedAt: confirmedAt,
    launchedJobId: null,
    lastError: null,
    createdAt: confirmedAt,
    updatedAt: confirmedAt
  })

  await saveDesignAbilities(db, designSessionId, draftPayload.abilities)
  await saveDesignPlan(db, designSessionId, plan)
  await saveDesignPlanProgress(db, designSessionId, {
    phase: 'plan_ready',
    status: 'completed',
    contextsRegistered: counts.tasks,
    contextsTotal: counts.tasks,
    milestones: counts.milestones,
    slices: counts.slices,
    tasks: counts.tasks,
    message: `计划已生成：${counts.tasks} 个步骤，请审阅后确认`
  })

  const taskProgress = defaultTaskProgress(plan.tasks)
  await db
    .update(designSessions)
    .set({
      taskPhase: taskProgress.phase,
      taskStatus: taskProgress.status,
      taskCurrentIndex: taskProgress.currentIndex,
      taskTotal: taskProgress.total,
      taskCurrentTaskId: taskProgress.currentTaskId ?? null,
      taskMessage: taskProgress.message ?? null,
      updatedAt: nowSec()
    })
    .where(eq(designSessions.id, designSessionId))

  await db
    .update(threads)
    .set({
      activeDraftId: draftMessageId,
      activePlanId: designSessionId,
      wizardPhase: 'ready_to_launch',
      updatedAt: nowSec()
    })
    .where(eq(threads.id, thread.id))

  return {
    coreCode: input.sessionCoreLabel,
    workspacePath: input.workspacePath,
    folderName: input.folderName,
    threadId: thread.id,
    designSessionId,
    projectId: project.id
  }
}

export async function launchSeededSession(
  username: string,
  threadId: string,
  designSessionId: string
): Promise<{ jobId: string; title: string; status: string }> {
  const job = await launchJobFromDesignSession(username, threadId, designSessionId, {
    skipQueueAdvance: true
  })
  return {
    jobId: job.id,
    title: job.title,
    status: job.status
  }
}

export async function launchPendingDesignSessions(username: string): Promise<void> {
  const db = getDb()
  const unlaunched = await db
    .select({
      id: designSessions.id,
      threadId: designSessions.threadId,
      title: designSessions.title
    })
    .from(designSessions)
    .where(
      and(
        eq(designSessions.username, username),
        eq(designSessions.status, 'plan_editing'),
        isNull(designSessions.launchedJobId),
        like(designSessions.title, '%CLI smoke%')
      )
    )

  if (unlaunched.length === 0) {
    console.log('No pending design sessions to launch.')
    return
  }

  console.log(`Launching ${unlaunched.length} pending design session(s)…\n`)
  for (const row of unlaunched) {
    try {
      const launched = await launchSeededSession(username, row.threadId, row.id)
      console.log(`${row.title} → ${launched.jobId} (${launched.status})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${row.title} → failed: ${message}`)
    }
  }

  const auth = await readAuth()
  await kickServerJobQueue(auth)
}

export function formatCoreLabel(
  coreCode: SupportedCoreCode | 'mixed',
  coreRotation?: SupportedCoreCode[]
): string {
  if (coreCode === 'mixed' && coreRotation) {
    return `混合 CLI (${formatCoreRotation(coreRotation)})`
  }
  if (coreCode === 'mixed') return '混合 CLI'
  return CORE_LABELS[coreCode]
}
