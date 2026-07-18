import type Database from 'better-sqlite3'

export function seedOwnedThreadJob(
  db: Database.Database,
  opts: {
    readonly jobId: string
    readonly username?: string
    readonly projectId?: string
    readonly threadId?: string
    readonly draftMessageId?: string
    readonly status?: string
  }
): void {
  const now = Date.now()
  const suffix = opts.jobId
  const username = opts.username ?? 'u1'
  const projectId = opts.projectId ?? `project-${suffix}`
  const threadId = opts.threadId ?? `thread-${suffix}`
  const draftMessageId = opts.draftMessageId ?? `draft-${suffix}`

  db.prepare(
    `INSERT OR IGNORE INTO projects (
      id, username, title, workspace_root, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(projectId, username, 'Project', '/tmp/control-plane-test', now, now)

  db.prepare(
    `INSERT OR IGNORE INTO threads (
      id, username, project_id, title, status, conversation_id, core_code, runtime_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(threadId, username, projectId, 'Thread', 'draft', 'conv-1', 'codex', 'idle', now, now)

  db.prepare(
    `INSERT OR IGNORE INTO thread_messages (
      id, thread_id, username, role, kind, content, core_code, conversation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    draftMessageId,
    threadId,
    username,
    'user',
    'task-launch-draft',
    'draft',
    'codex',
    'conv-1',
    new Date(now).toISOString()
  )

  db.prepare(
    `INSERT OR IGNORE INTO thread_jobs (
      id, thread_id, username, draft_message_id, title, summary, status, workspace_path,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.jobId,
    threadId,
    username,
    draftMessageId,
    'Thread Job',
    '',
    opts.status ?? 'pending',
    '/tmp/control-plane-test/workspace',
    now,
    now
  )
}
