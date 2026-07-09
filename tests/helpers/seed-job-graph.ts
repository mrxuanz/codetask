import { projects, threadJobs, threadMessages, threads } from '../../src/server/db/schema'
import type { getDb } from '../../src/server/db'

type AppDatabase = ReturnType<typeof getDb>

/** Seed project + thread + draft message + job so draft_message_id triggers pass. */
export async function seedJobGraph(
  db: AppDatabase,
  input: {
    jobId: string
    username: string
    threadId: string
    draftMessageId: string
    status: string
    workspacePath?: string
    executionLeaseOwner?: string | null
    executionLeaseExpiresAt?: number | null
  }
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const projectId = `proj-${input.jobId}`

  await db.insert(projects).values({
    id: projectId,
    username: input.username,
    title: 'P',
    workspaceRoot: input.workspacePath ?? '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threads).values({
    id: input.threadId,
    username: input.username,
    projectId,
    title: 'T',
    status: 'draft',
    conversationId: `conv-${input.jobId}`,
    coreCode: 'cursor',
    runtimeStatus: 'idle',
    coreRuntimeJson: '{}',
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threadMessages).values({
    id: input.draftMessageId,
    threadId: input.threadId,
    username: input.username,
    role: 'assistant',
    kind: 'task-launch-draft',
    content: '{}',
    coreCode: 'cursor',
    conversationId: `conv-${input.jobId}`,
    createdAt: String(now)
  })
  await db.insert(threadJobs).values({
    id: input.jobId,
    threadId: input.threadId,
    username: input.username,
    draftMessageId: input.draftMessageId,
    title: 'Test',
    summary: '',
    status: input.status,
    workspacePath: input.workspacePath ?? '/tmp/ws',
    executionLeaseOwner: input.executionLeaseOwner ?? null,
    executionLeaseExpiresAt: input.executionLeaseExpiresAt ?? null,
    createdAt: now,
    updatedAt: now
  })
}
