import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import { getDb } from '../../src/server/db'
import {
  messageArtifacts,
  projects,
  threadJobs,
  threadMessages,
  threads
} from '../../src/server/db/schema'
import { attachmentDir, messageArtifactDir } from '../../src/server/data-paths'
import { deleteUserDraft, listUserDrafts } from '../../src/server/legacy-control-plane/draft-plan'
import {
  resetJobReconcileForTests,
  stopWorkloadReconcilerForTests
} from '../../src/server/legacy-control-plane/reconcile'
import { ensureStartupWorkloadReady } from '../../src/server/legacy-control-plane/workload-slot'
import { resetWorkloadRunControllersForTests } from '../../src/server/legacy-control-plane/workload-slot-store'
import { resetWorkspaceLeaseStateForTests } from '../../src/server/legacy-control-plane/workspace-lease-store'
import { THREAD_KIND_CREATE_TASK, THREAD_KIND_TASK_SNAPSHOT } from '../../src/server/threads/types'

let dataDir = ''

async function setup(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), 'codetask-delete-draft-'))
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  resetJobReconcileForTests()
  bootstrapRuntime({ dataDir })
  await ensureStartupWorkloadReady()
  stopWorkloadReconcilerForTests()
}

async function teardown(): Promise<void> {
  resetWorkloadRunControllersForTests()
  await resetAppContextForTests()
  resetWorkspaceLeaseStateForTests()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function seedDraft(input: {
  draftId: string
  threadId: string
  projectId: string
  title: string
  status?: string
  attachmentId?: string
  job?: {
    id: string
    status: string
    planConfirmedAt: number | null
  }
}): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    draftId: input.draftId,
    sourceMessageId: input.draftId,
    title: input.title,
    summary: `${input.title} summary`,
    userFlow: '',
    techStack: '',
    nfr: [],
    acceptance: [],
    verification: [],
    outOfScope: [],
    assumptions: [],
    requirementsContract: { markdown: '', status: 'pending' },
    workspacePath: join(dataDir, 'workspace'),
    status: input.status ?? 'editing',
    lockedSections: {},
    abilities: [],
    references: input.attachmentId
      ? [
          {
            id: input.attachmentId,
            name: 'note.txt',
            mimeType: 'text/plain',
            kind: 'file',
            assetUrl: `/api/threads/${input.threadId}/attachments/${input.attachmentId}`,
            source: 'upload'
          }
        ]
      : [],
    sourceAttachments: []
  }

  db.insert(projects)
    .values({
      id: input.projectId,
      username: 'user',
      title: 'Project',
      workspaceRoot: join(dataDir, 'workspace'),
      createdAt: now,
      updatedAt: now
    })
    .run()

  db.insert(threads)
    .values({
      id: input.threadId,
      username: 'user',
      projectId: input.projectId,
      title: 'Thread',
      status: 'draft',
      threadKind: THREAD_KIND_CREATE_TASK,
      conversationId: `conv-${input.threadId}`,
      coreCode: 'cursor',
      runtimeStatus: 'idle',
      coreRuntimeJson: '{}',
      createdAt: now,
      updatedAt: now
    })
    .run()

  db.insert(threadMessages)
    .values({
      id: input.draftId,
      threadId: input.threadId,
      username: 'user',
      role: 'assistant',
      kind: 'task-launch-draft',
      content: input.title,
      payloadJson: JSON.stringify(payload),
      coreCode: 'cursor',
      conversationId: `conv-${input.threadId}`,
      createdAt: String(now)
    })
    .run()

  db.update(threads)
    .set({ activeDraftId: input.draftId, updatedAt: now })
    .where(eq(threads.id, input.threadId))
    .run()

  if (input.attachmentId) {
    const dir = attachmentDir(dataDir, input.threadId, input.attachmentId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'note.txt'), 'draft file')
  }

  if (input.job) {
    db.insert(threadJobs)
      .values({
        id: input.job.id,
        threadId: input.threadId,
        username: 'user',
        draftMessageId: input.draftId,
        title: input.title,
        summary: '',
        status: input.job.status,
        workspacePath: join(dataDir, 'workspace'),
        planConfirmedAt: input.job.planConfirmedAt,
        createdAt: now,
        updatedAt: now
      })
      .run()
  }
}

test('deleteUserDraft removes unlaunched draft, planning job, and attachment files', async (t) => {
  await setup()
  t.after(teardown)

  const draftId = 'draft-unlaunched'
  const threadId = 'thread-unlaunched'
  const attachmentId = 'att-33333333-3333-4333-8333-333333333333'
  seedDraft({
    draftId,
    threadId,
    projectId: 'proj-unlaunched',
    title: 'Unlaunched draft',
    attachmentId,
    job: {
      id: 'job-planning',
      status: 'plan_editing',
      planConfirmedAt: null
    }
  })

  const attachmentPath = attachmentDir(dataDir, threadId, attachmentId)
  const artifactPath = messageArtifactDir(dataDir, draftId)
  mkdirSync(artifactPath, { recursive: true })
  writeFileSync(join(artifactPath, 'payload.json.gz'), 'artifact')
  getDb()
    .insert(messageArtifacts)
    .values({
      id: 'msg-art-unlaunched',
      messageId: draftId,
      kind: 'payload',
      contentHash: 'hash',
      byteSize: 8,
      storage: 'file',
      contentPath: 'unused-in-test',
      createdAt: Math.floor(Date.now() / 1000)
    })
    .run()
  assert.equal(existsSync(join(attachmentPath, 'note.txt')), true)

  const result = await deleteUserDraft('user', threadId, draftId)
  assert.equal(result.mode, 'removed')
  assert.equal(result.keptJobId, null)

  const messages = getDb().select().from(threadMessages).where(eq(threadMessages.id, draftId)).all()
  assert.equal(messages.length, 0)

  const jobs = getDb().select().from(threadJobs).where(eq(threadJobs.id, 'job-planning')).all()
  assert.equal(jobs.length, 0)

  assert.equal(existsSync(attachmentPath), false)
  assert.equal(existsSync(artifactPath), false)
  assert.equal(
    getDb().select().from(messageArtifacts).where(eq(messageArtifacts.messageId, draftId)).all()
      .length,
    0
  )

  const thread = getDb().select().from(threads).where(eq(threads.id, threadId)).all()[0]
  assert.equal(thread, undefined)

  const listed = await listUserDrafts('user')
  assert.equal(
    listed.some((entry) => entry.messageId === draftId),
    false
  )
})

test('deleteUserDraft removes its aggregate and keeps an independently published task', async (t) => {
  await setup()
  t.after(teardown)

  const draftId = 'draft-launched'
  const threadId = 'thread-launched'
  const designSessionId = 'design-published'
  const jobId = 'job-launched'
  const taskThreadId = 'task-snapshot-thread'
  const taskMessageId = 'task-snapshot-message'
  const now = Math.floor(Date.now() / 1000)
  seedDraft({
    draftId,
    threadId,
    projectId: 'proj-launched',
    title: 'Launched draft',
    status: 'confirmed',
    job: {
      id: designSessionId,
      status: 'published',
      planConfirmedAt: null
    }
  })

  getDb()
    .insert(threads)
    .values({
      id: taskThreadId,
      username: 'user',
      projectId: 'proj-launched',
      title: 'Task snapshot',
      status: 'draft',
      threadKind: THREAD_KIND_TASK_SNAPSHOT,
      conversationId: `conv-${taskThreadId}`,
      coreCode: 'cursor',
      runtimeStatus: 'idle',
      coreRuntimeJson: '{}',
      createdAt: now,
      updatedAt: now
    })
    .run()
  getDb()
    .insert(threadMessages)
    .values({
      id: taskMessageId,
      threadId: taskThreadId,
      username: 'user',
      role: 'assistant',
      kind: 'task-launch-draft',
      content: 'Task snapshot',
      payloadJson: '{}',
      coreCode: 'cursor',
      conversationId: `conv-${taskThreadId}`,
      createdAt: String(now)
    })
    .run()
  getDb()
    .insert(threadJobs)
    .values({
      id: jobId,
      threadId: taskThreadId,
      username: 'user',
      draftMessageId: taskMessageId,
      title: 'Launched draft',
      summary: '',
      status: 'running',
      workspacePath: join(dataDir, 'workspace'),
      planConfirmedAt: now,
      designSessionId,
      createdAt: now,
      updatedAt: now
    })
    .run()

  const result = await deleteUserDraft('user', threadId, draftId)
  assert.equal(result.mode, 'removed')
  assert.equal(result.keptJobId, null)

  assert.equal(getDb().select().from(threads).where(eq(threads.id, threadId)).all().length, 0)
  assert.equal(
    getDb().select().from(threadJobs).where(eq(threadJobs.id, designSessionId)).all().length,
    0
  )

  const job = getDb().select().from(threadJobs).where(eq(threadJobs.id, jobId)).all()[0]
  assert.ok(job)
  assert.equal(job.planConfirmedAt, now)
  assert.ok(getDb().select().from(threads).where(eq(threads.id, taskThreadId)).all()[0])

  const listed = await listUserDrafts('user')
  assert.equal(
    listed.some((entry) => entry.messageId === draftId),
    false
  )
})
