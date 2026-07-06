import type { createIsolatedTestDatabase } from '../../src/server/db'
import { projects, threadJobs, threadMessages, threads } from '../../src/server/db/schema'

export async function seedMinimalJob(
  db: ReturnType<typeof createIsolatedTestDatabase>,
  jobId: string,
  status: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await db.insert(projects).values({
    id: 'proj-1',
    username: 'user',
    title: 'P',
    workspaceRoot: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threads).values({
    id: 'thread-1',
    username: 'user',
    projectId: 'proj-1',
    title: 'T',
    status: 'draft',
    conversationId: 'conv-1',
    coreCode: 'cursor',
    runtimeStatus: 'idle',
    coreRuntimeJson: '{}',
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threadMessages).values({
    id: 'draft-1',
    threadId: 'thread-1',
    username: 'user',
    role: 'assistant',
    kind: 'task-launch-draft',
    content: '{}',
    coreCode: 'cursor',
    conversationId: 'conv-1',
    createdAt: new Date().toISOString()
  })
  await db.insert(threadJobs).values({
    id: jobId,
    threadId: 'thread-1',
    username: 'user',
    draftMessageId: 'draft-1',
    title: 'Test',
    summary: '',
    status,
    workspacePath: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })
}
