import type { createIsolatedTestDatabase } from '../../src/server/db'
import { projects } from '../../src/server/db/schema'

function sqliteClient(
  db: ReturnType<typeof createIsolatedTestDatabase>
): import('better-sqlite3').Database | null {
  return (db as { $client?: import('better-sqlite3').Database }).$client ?? null
}

/** Seed project + conversation_threads for retention fixtures. */
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
  const client = sqliteClient(db)
  const iso = new Date(now * 1000).toISOString()
  client
    ?.prepare(
      `INSERT INTO conversation_threads (
         id, actor_id, project_id, title, title_source, provider_code, state,
         state_revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'auto', 'cursor', 'active', 0, ?, ?)`
    )
    .run('thread-1', 'user', 'proj-1', 'T', iso, iso)
}
