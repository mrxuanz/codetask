/**
 * Image attachment + reference-path business oracles.
 * Phrase match ignores case/whitespace; does not treat scattered tokens as success.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PublicApiClient } from '../api/client'
import * as ops from '../api/operations'
import type { OracleResult } from './http-state'

const REFS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/references')

export const IMAGE_EXPECTED_TEXT = 'Dream of 1000 Cats'
export const IMAGE_UPLOAD_FILE_NAME = 'attachment.png'
export const IMAGE_FIXTURE_FILE = 'ocr-dream-cats.png'

export const REF_SENTINELS = {
  overview: 'DESIGN_OVERVIEW_731',
  api: 'DESIGN_API_842',
  constraints: 'DESIGN_CONSTRAINT_953'
} as const

export const IMAGE_FORBIDDEN_LEAK_TOKENS = ['Dream', '1000', 'Cats'] as const
export const REF_FORBIDDEN_LEAK_TOKENS = [
  ...IMAGE_FORBIDDEN_LEAK_TOKENS,
  REF_SENTINELS.overview,
  REF_SENTINELS.api,
  REF_SENTINELS.constraints
] as const

export function normalizeAttachmentText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

export function recognizesImageText(text: string, expected: string = IMAGE_EXPECTED_TEXT): boolean {
  if (!text?.trim() || !expected?.trim()) return false
  return normalizeAttachmentText(text).includes(normalizeAttachmentText(expected))
}

export function assertNoLeak(label: string, value: string, tokens: readonly string[]): void {
  const lower = value.toLowerCase()
  for (const token of tokens) {
    if (lower.includes(token.toLowerCase())) {
      throw new Error(`attachment_prompt_leak:${label}:${token}`)
    }
  }
}

export function resolveImageFixturePath(imageFile = IMAGE_FIXTURE_FILE): string {
  return join(REFS_ROOT, imageFile)
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path))
}

export function ensureReferenceCorpus(rootDir: string): {
  designDocsDir: string
  files: Record<string, string>
} {
  const designDocsDir = resolve(rootDir, 'design-docs')
  const nested = join(designDocsDir, 'nested')
  mkdirSync(nested, { recursive: true })
  const files = {
    overview: join(designDocsDir, 'overview.md'),
    api: join(designDocsDir, 'api.md'),
    constraints: join(nested, 'constraints.md')
  }
  writeFileSync(files.overview, `${REF_SENTINELS.overview}\n`, 'utf8')
  writeFileSync(files.api, `${REF_SENTINELS.api}\n`, 'utf8')
  writeFileSync(files.constraints, `${REF_SENTINELS.constraints}\n`, 'utf8')
  return { designDocsDir, files }
}

/** Place corpus beside workspaces/, never inside the project workspace. */
export function referenceCorpusRootForWorkspace(workspaceRoot: string): string {
  const workspacesDir = dirname(resolve(workspaceRoot))
  const runRoot = dirname(workspacesDir)
  const caseName = workspaceRoot.split(/[/\\]/).filter(Boolean).pop() || 'case'
  return join(runRoot, 'reference-corpus', caseName)
}

function writeEvidence(dir: string | undefined, name: string, payload: unknown): void {
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function messageContent(message: Record<string, unknown>): string {
  const candidates = [message.content, message.text, message.body, message.markdown]
  for (const item of candidates) {
    if (typeof item === 'string') return item
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function attachmentIdsOf(message: Record<string, unknown>): string[] {
  const attachments = message.attachments
  if (!Array.isArray(attachments)) return []
  return attachments
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      return String((item as { id?: unknown }).id ?? '')
    })
    .filter(Boolean)
}

function unwrapDraftList(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>
  if (raw && typeof raw === 'object') {
    const obj = raw as { drafts?: unknown; data?: unknown }
    if (Array.isArray(obj.drafts)) return obj.drafts as Array<Record<string, unknown>>
    if (Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>
  }
  return []
}

function extractDraftPayload(
  message: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!message) return null
  const payload = message.payload
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>
  return null
}

export async function assertAttachmentBytesMatchFixture(input: {
  client: PublicApiClient
  threadId: string
  attachmentId: string
  fixturePath?: string
}): Promise<OracleResult> {
  const fixturePath = input.fixturePath ?? resolveImageFixturePath()
  const expectedHash = sha256File(fixturePath)
  try {
    const downloaded = await ops.downloadThreadAttachment(
      input.client,
      input.threadId,
      input.attachmentId
    )
    const actualHash = sha256Buffer(downloaded)
    return {
      name: 'attachment_sha256_matches_fixture',
      passed: actualHash === expectedHash && downloaded.length > 0,
      detail: { expectedHash, actualHash, bytes: downloaded.length }
    }
  } catch (error) {
    return {
      name: 'attachment_sha256_matches_fixture',
      passed: false,
      detail: { error: String(error), expectedHash }
    }
  }
}

export async function runChatImageAttachmentOracle(input: {
  client: PublicApiClient
  threadId: string
  turnId: string
  attachmentId: string
  expectedCoreCode: string
  messageIdsBefore: Set<string>
  evidenceDir?: string
}): Promise<OracleResult[]> {
  const results: OracleResult[] = []
  const messages = await ops.listMessages(input.client, input.threadId)
  writeEvidence(input.evidenceDir, 'attachment-result.json', {
    case: 'CHAT-IMG-001',
    turnId: input.turnId,
    attachmentId: input.attachmentId,
    messages
  })

  const { turn } = await ops.getTurn(input.client, input.threadId, input.turnId)
  results.push({
    name: 'turn_completed',
    passed: String(turn.status) === 'completed',
    detail: { status: turn.status }
  })

  const thread = await ops.getThread(input.client, input.threadId)
  const actualCore = String(thread.coreCode ?? thread.core_code ?? '')
  results.push({
    name: 'thread_core_matches',
    passed: actualCore === input.expectedCoreCode,
    detail: { expected: input.expectedCoreCode, actual: actualCore }
  })

  const newMessages = messages.filter((item) => {
    const id = typeof item.id === 'string' ? item.id : ''
    return id && !input.messageIdsBefore.has(id)
  })
  const newAssistants = newMessages.filter((item) => item.role === 'assistant')
  const newUsers = newMessages.filter((item) => item.role === 'user')

  results.push({
    name: 'new_assistant_message_present',
    passed: newAssistants.length > 0,
    detail: { count: newAssistants.length }
  })

  results.push({
    name: 'user_message_has_attachment',
    passed: newUsers.some((item) => attachmentIdsOf(item).includes(input.attachmentId)),
    detail: { attachmentId: input.attachmentId }
  })

  results.push(
    await assertAttachmentBytesMatchFixture({
      client: input.client,
      threadId: input.threadId,
      attachmentId: input.attachmentId
    })
  )

  const assistantText = newAssistants.map((item) => messageContent(item)).join('\n')
  results.push({
    name: 'chat_image_text_recognized',
    passed: recognizesImageText(assistantText),
    detail: { expected: IMAGE_EXPECTED_TEXT }
  })

  return results
}

export async function runDraftChatImageAttachmentOracle(input: {
  client: PublicApiClient
  threadId: string
  draftMessageId: string
  attachmentId: string
  evidenceDir?: string
}): Promise<OracleResult[]> {
  const results: OracleResult[] = []
  const drafts = unwrapDraftList(await ops.listThreadDrafts(input.client, input.threadId))
  const summary = drafts.find((row) => String(row.messageId ?? '') === input.draftMessageId) ?? null
  const collecting = summary?.collecting === true || summary?.status === 'collecting'

  results.push({
    name: 'draft_present',
    passed: Boolean(summary),
    detail: { draftMessageId: input.draftMessageId }
  })
  results.push({
    name: 'draft_confirmable',
    passed: Boolean(summary) && !collecting,
    detail: { collecting, status: summary?.status ?? null }
  })

  const messages = await ops.listMessages(input.client, input.threadId)
  const draftMessage =
    messages.find((item) => String(item.id ?? '') === input.draftMessageId) ?? null
  const payload = extractDraftPayload(draftMessage)
  writeEvidence(input.evidenceDir, 'attachment-result.json', {
    case: 'DRAFT-CHAT-IMG-001',
    draftMessageId: input.draftMessageId,
    payload
  })

  if (!payload) {
    results.push({
      name: 'draft_image_text_recognized',
      passed: false,
      detail: { reason: 'payload_missing' }
    })
    return results
  }

  const sourceAttachments = Array.isArray(payload.sourceAttachments)
    ? payload.sourceAttachments
    : []
  results.push({
    name: 'draft_source_attachment',
    passed: sourceAttachments.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        String((item as { id?: unknown }).id) === input.attachmentId
    ),
    detail: { attachmentId: input.attachmentId }
  })

  results.push(
    await assertAttachmentBytesMatchFixture({
      client: input.client,
      threadId: input.threadId,
      attachmentId: input.attachmentId
    })
  )

  const title = typeof payload.title === 'string' ? payload.title : ''
  const summaryText = typeof payload.summary === 'string' ? payload.summary : ''
  results.push({
    name: 'draft_image_text_recognized',
    passed: recognizesImageText(title) || recognizesImageText(summaryText),
    detail: { expected: IMAGE_EXPECTED_TEXT, title, summary: summaryText }
  })

  return results
}

function collectPlanText(plan: unknown): string {
  if (!plan || typeof plan !== 'object') return ''
  const parts: string[] = []
  const visit = (value: unknown, depth = 0): void => {
    if (value == null || depth > 8) return
    if (typeof value === 'string') {
      parts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) visit(child, depth + 1)
    }
  }
  visit(plan)
  return parts.join('\n')
}

function tasksFromPlan(plan: unknown): Array<Record<string, unknown>> {
  if (!plan || typeof plan !== 'object') return []
  const record = plan as { tasks?: unknown; milestones?: unknown }
  const out: Array<Record<string, unknown>> = []
  if (Array.isArray(record.tasks)) {
    for (const task of record.tasks) {
      if (task && typeof task === 'object') out.push(task as Record<string, unknown>)
    }
  }
  if (Array.isArray(record.milestones)) {
    for (const milestone of record.milestones) {
      if (!milestone || typeof milestone !== 'object') continue
      const slices = (milestone as { slices?: unknown }).slices
      if (!Array.isArray(slices)) continue
      for (const slice of slices) {
        if (!slice || typeof slice !== 'object') continue
        const tasks = (slice as { tasks?: unknown }).tasks
        if (!Array.isArray(tasks)) continue
        for (const task of tasks) {
          if (task && typeof task === 'object') out.push(task as Record<string, unknown>)
        }
      }
    }
  }
  const seenIds = new Set<string>()
  return out.filter((task) => {
    const id = String(task.id ?? '')
    if (!id) return true
    if (seenIds.has(id)) return false
    seenIds.add(id)
    return true
  })
}

export function extractPlanReferenceEvidence(input: {
  planRecord: Record<string, unknown> | null
  launchedJob: Record<string, unknown> | null
  attachmentId: string
  directoryReferenceId: string
}): {
  manifestIds: string[]
  tasks: Array<Record<string, unknown>>
  taskReferenceIds: string[]
  taskWithBoth: Record<string, unknown> | null
  plan: unknown
} {
  const candidates = [
    input.launchedJob?.plan,
    input.planRecord?.plan,
    input.launchedJob,
    input.planRecord
  ]
  let plan: unknown = null
  let tasks: Array<Record<string, unknown>> = []
  for (const candidate of candidates) {
    const candidateTasks = tasksFromPlan(candidate)
    if (candidateTasks.length > tasks.length) {
      plan = candidate
      tasks = candidateTasks
    }
  }

  const manifests = [
    input.launchedJob?.referenceManifest,
    input.planRecord?.referenceManifest
  ] as Array<unknown>
  let manifestIds: string[] = []
  for (const candidate of manifests) {
    if (!candidate || typeof candidate !== 'object') continue
    const references = (candidate as { references?: unknown }).references
    if (!Array.isArray(references)) continue
    const ids = references
      .map((item) =>
        item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '') : ''
      )
      .filter(Boolean)
    if (ids.length > manifestIds.length) manifestIds = ids
  }

  const taskWithBoth =
    tasks.find((task) => {
      const ids = Array.isArray(task.referenceIds) ? task.referenceIds.map(String) : []
      const reason = typeof task.referenceReason === 'string' ? task.referenceReason.trim() : ''
      return (
        ids.includes(input.attachmentId) &&
        ids.includes(input.directoryReferenceId) &&
        reason.length > 0
      )
    }) ?? null

  const taskReferenceIds = [
    ...new Set(
      tasks.flatMap((task) => {
        const reason = typeof task.referenceReason === 'string' ? task.referenceReason.trim() : ''
        return reason && Array.isArray(task.referenceIds) ? task.referenceIds.map(String) : []
      })
    )
  ]

  return { manifestIds, tasks, taskReferenceIds, taskWithBoth, plan }
}

export function recognizesReferenceProof(proof: unknown): boolean {
  if (!proof || typeof proof !== 'object') return false
  const record = proof as {
    imageText?: unknown
    image_text?: unknown
    documents?: unknown
    designInfo?: unknown
    designData?: unknown
    design_docs?: unknown
  }
  if (!recognizesImageText(String(record.imageText ?? record.image_text ?? ''))) return false

  const objectCandidates = [record.documents, record.designInfo].filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
  )
  const directObjectMatch = objectCandidates.some(
    (item) =>
      String(item.overview ?? '').includes(REF_SENTINELS.overview) &&
      String(item.api ?? '').includes(REF_SENTINELS.api) &&
      String(item.constraints ?? '').includes(REF_SENTINELS.constraints)
  )

  const rowCandidates: unknown[][] = [record.designData, record.design_docs]
    .filter(Array.isArray)
    .map((rows) => rows as unknown[])
  for (const item of objectCandidates) {
    if (Array.isArray(item.files)) rowCandidates.push(item.files)
  }
  const designRowsMatch = rowCandidates.some((rows) => {
    const byPath = new Map<string, string>()
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue
      const row = item as { path?: unknown; content?: unknown }
      byPath.set(String(row.path ?? '').replaceAll('\\', '/'), String(row.content ?? ''))
    }
    return (
      String(byPath.get('overview.md') ?? '').includes(REF_SENTINELS.overview) &&
      String(byPath.get('api.md') ?? '').includes(REF_SENTINELS.api) &&
      String(byPath.get('nested/constraints.md') ?? '').includes(REF_SENTINELS.constraints)
    )
  })

  return directObjectMatch || designRowsMatch
}

export async function runDraftReferencePathOracle(input: {
  client: PublicApiClient
  threadId: string
  draftMessageId: string
  attachmentId: string
  directoryReferenceId: string
  designSessionId: string
  launchedJobId: string
  launchedThreadId: string
  localCorpusPath: string
  workspaceRoot: string
  evidenceDir?: string
}): Promise<OracleResult[]> {
  const results: OracleResult[] = []
  const messages = await ops.listMessages(input.client, input.threadId)
  const draftMessage =
    messages.find((item) => String(item.id ?? '') === input.draftMessageId) ?? null
  const payload = extractDraftPayload(draftMessage)
  const references = Array.isArray(payload?.references)
    ? (payload!.references as Array<Record<string, unknown>>)
    : []

  const imageRef = references.find((item) => String(item.id ?? '') === input.attachmentId)
  results.push({
    name: 'draft_image_reference_imported',
    passed: Boolean(
      imageRef &&
      (imageRef.source === 'import' || imageRef.source === 'message') &&
      imageRef.kind === 'image' &&
      String(imageRef.description ?? '').trim().length > 0
    ),
    detail: { imageRef }
  })

  const dirRef = references.find((item) => String(item.id ?? '') === input.directoryReferenceId)
  const localPath = typeof dirRef?.localPath === 'string' ? dirRef.localPath : ''
  const resolvedLocal = localPath ? resolve(localPath) : ''
  const expectedLocal = resolve(input.localCorpusPath)
  results.push({
    name: 'draft_local_corpus_reference',
    passed: Boolean(
      dirRef &&
      dirRef.source === 'local_corpus' &&
      dirRef.kind === 'directory' &&
      existsSync(expectedLocal) &&
      resolvedLocal === expectedLocal &&
      String(dirRef.description ?? '').trim().length > 0
    ),
    detail: { dirRef, expectedLocal, resolvedLocal }
  })

  let job: Record<string, unknown> | null = null
  try {
    job = await ops.getJob(input.client, input.launchedThreadId, input.launchedJobId)
  } catch (error) {
    results.push({
      name: 'job_launched',
      passed: false,
      detail: { error: String(error) }
    })
  }

  const plans = await ops.listThreadPlans(input.client, input.threadId)
  const planRecord =
    plans.find((item) => String(item.id ?? item.designSessionId ?? '') === input.designSessionId) ??
    null
  const planEvidence = extractPlanReferenceEvidence({
    planRecord,
    launchedJob: job,
    attachmentId: input.attachmentId,
    directoryReferenceId: input.directoryReferenceId
  })
  const manifestIds = new Set(planEvidence.manifestIds)
  const taskWithBoth = planEvidence.taskWithBoth
  const taskReferenceIds = new Set(planEvidence.taskReferenceIds)
  const plan = planEvidence.plan

  results.push({
    name: 'planner_reference_manifest',
    passed:
      (manifestIds.has(input.attachmentId) && manifestIds.has(input.directoryReferenceId)) ||
      Boolean(taskWithBoth),
    detail: { manifestIds: [...manifestIds], taskWithBoth: Boolean(taskWithBoth) }
  })

  results.push({
    name: 'planner_task_references',
    passed:
      taskReferenceIds.has(input.attachmentId) && taskReferenceIds.has(input.directoryReferenceId),
    detail: {
      attachmentId: input.attachmentId,
      directoryReferenceId: input.directoryReferenceId,
      taskCount: planEvidence.tasks.length,
      taskReferenceIds: [...taskReferenceIds],
      assignedTogether: Boolean(taskWithBoth)
    }
  })

  if (job) {
    results.push({
      name: 'job_launched',
      passed: String(job.id ?? '') === input.launchedJobId,
      detail: { status: job.status, id: job.id }
    })
  }

  const proofPath = join(input.workspaceRoot, 'reference-proof.json')
  let proofPassed = false
  let proofDetail: unknown = { path: proofPath, exists: existsSync(proofPath) }
  if (existsSync(proofPath)) {
    try {
      const proof = JSON.parse(readFileSync(proofPath, 'utf8')) as Record<string, unknown>
      const imageOk = recognizesImageText(String(proof.imageText ?? proof.image_text ?? ''))
      proofPassed = recognizesReferenceProof(proof)
      proofDetail = { proof, imageOk }
    } catch (error) {
      proofDetail = { error: String(error) }
    }
  }
  results.push({
    name: 'reference_proof_file_oracle',
    passed: proofPassed,
    detail: proofDetail
  })

  writeEvidence(input.evidenceDir, 'attachment-result.json', {
    case: 'DRAFT-REF-PATH-001',
    draftMessageId: input.draftMessageId,
    designSessionId: input.designSessionId,
    launchedJobId: input.launchedJobId,
    launchedThreadId: input.launchedThreadId,
    references,
    planTextSample: collectPlanText(plan).slice(0, 2000),
    proofDetail
  })

  return results
}
