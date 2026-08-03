import type { createIsolatedTestDatabase } from '../../src/server/db'
import { projects, threadMessages, threads } from '../../src/server/db/schema'

/** Seed project/thread/message graph for retention fixtures (no legacy thread_jobs). */
export async function seedMinimalJob(
  db: ReturnType<typeof createIsolatedTestDatabase>,
  _jobId: string,
  _status: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await db.insert(projects).values({
    id: 'proj-1',
    actorId: 'user',
    title: 'P',
    workspaceRoot: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })
  await db.insert(threads).values({
    id: 'thread-1',
    actorId: 'user',
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
    actorId: 'user',
    role: 'assistant',
    kind: 'text',
    content: '{}',
    coreCode: 'cursor',
    conversationId: 'conv-1',
    createdAt: new Date().toISOString()
  })
}
