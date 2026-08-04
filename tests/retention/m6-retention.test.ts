import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import { jobArtifacts, projects } from '../../src/server/db/schema'

import { SettingsStore } from '../../src/server/context/settings-store'
import { DEFAULT_RETENTION_SETTINGS } from '@codetask/contracts'
import {
  pruneStaleThreadAttachmentDirs,
  wipeLegacyProductRuntimes
} from '../../src/server/retention/janitor'
import { jobRuntimeDir } from '../../src/server/runtime/cleanup'
import {
  collectThreadPurgeTargets,
  purgeJobFilesystem,
  purgeThreadFilesystem
} from '../../src/server/retention/purge'
import {
  runSqliteMaintenance,
  runSqliteMaintenanceIfDue,
  shouldRunSqliteMaintenance
} from '../../src/server/retention/maintenance'
import { putJobArtifact } from '../../src/server/retention/artifacts'
import {
  attachmentDir,
  messageArtifactDir,
  threadAttachmentsDir
} from '../../src/server/data-paths'
import { seedMinimalJob } from '../helpers/seed-minimal-job'

async function seedThreadGraph(
  db: ReturnType<typeof createIsolatedTestDatabase>,
  input: {
    threadId?: string
    designSessionId?: string
    messageId?: string
    execMessageId?: string
    jobId?: string
    attachmentId?: string
  } = {}
): Promise<{
  threadId: string
  designSessionId: string
  messageId: string
  jobId: string
  attachmentId: string
}> {
  const now = Math.floor(Date.now() / 1000)
  const threadId = input.threadId ?? 'thread-1'
  const designSessionId = input.designSessionId ?? 'ds-1'
  const messageId = input.messageId ?? 'draft-1'
  const execMessageId = input.execMessageId ?? 'draft-exec-1'
  const jobId = input.jobId ?? 'job-1'
  const attachmentId = input.attachmentId ?? 'att-1'

  await db.insert(projects).values({
    id: 'proj-1',
    actorId: 'user',
    title: 'P',
    workspaceRoot: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })

  const client = (db as { $client?: import('better-sqlite3').Database }).$client
  const iso = new Date(now * 1000).toISOString()
  client
    ?.prepare(
      `INSERT INTO conversation_threads (
         id, actor_id, project_id, title, title_source, provider_code, state,
         state_revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'auto', 'cursor', 'active', 0, ?, ?)`
    )
    .run(threadId, 'user', 'proj-1', 'T', iso, iso)

  client
    ?.prepare(
      `INSERT INTO conversation_messages (
         id, conversation_id, role, kind, content, created_at
       ) VALUES (?, ?, 'assistant', 'text', '{}', ?)`
    )
    .run(messageId, threadId, iso)

  client
    ?.prepare(
      `INSERT INTO conversation_message_attachments (
         id, message_id, conversation_id, asset_id, name, mime_type, size_bytes, kind, sort_order, created_at
       ) VALUES (?, ?, ?, ?, 'ref.png', 'image/png', 3, 'image', 0, ?)`
    )
    .run(attachmentId, messageId, threadId, attachmentId, iso)

  client
    ?.prepare(
      `INSERT INTO conversation_messages (
         id, conversation_id, role, kind, content, created_at
       ) VALUES (?, ?, 'assistant', 'text', '{}', ?)`
    )
    .run(execMessageId, threadId, iso)

  // Attachment validity comes from conversation_message_attachments.
  void designSessionId
  void execMessageId
  void jobId

  return { threadId, designSessionId, messageId, jobId, attachmentId }
}

test('purgeJobFilesystem removes job artifacts and runtime tree', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-job-purge-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const { threadId, jobId } = await seedThreadGraph(db)
    await putJobArtifact({
      db,
      dataDir,
      jobId,
      taskId: 't1',
      kind: 'task_evidence',
      payload: {
        status: 'completed',
        summary: 'ok',
        changedFiles: [],
        evidence: [],
        validation: { ran: true, outcome: 'passed' }
      },
      settings: { ...DEFAULT_RETENTION_SETTINGS, artifactInlineMaxBytes: 16 }
    })

    const runtimeDir = join(dataDir, 'runtimes', threadId, 'jobs', jobId)
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'state.json'), '{}')

    await purgeJobFilesystem(dataDir, threadId, jobId)

    assert.equal(existsSync(runtimeDir), false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('purgeThreadFilesystem removes attachments and message artifacts', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-thread-purge-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const { threadId, messageId, attachmentId } = await seedThreadGraph(db)
    const targets = await collectThreadPurgeTargets(db, threadId)

    mkdirSync(attachmentDir(dataDir, threadId, attachmentId), { recursive: true })
    writeFileSync(join(attachmentDir(dataDir, threadId, attachmentId), 'ref.png'), 'png')
    mkdirSync(messageArtifactDir(dataDir, messageId), { recursive: true })
    writeFileSync(join(messageArtifactDir(dataDir, messageId), 'payload.json.gz'), 'gz')
    mkdirSync(join(join(dataDir, 'runtimes'), threadId), { recursive: true })

    await purgeThreadFilesystem(dataDir, threadId, targets)

    assert.equal(existsSync(threadAttachmentsDir(dataDir, threadId)), false)
    assert.equal(existsSync(messageArtifactDir(dataDir, messageId)), false)
    assert.equal(existsSync(join(join(dataDir, 'runtimes'), threadId)), false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('janitor prunes stale attachment dirs', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-janitor-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const { threadId, attachmentId } = await seedThreadGraph(db)

    mkdirSync(attachmentDir(dataDir, threadId, attachmentId), { recursive: true })
    mkdirSync(attachmentDir(dataDir, threadId, 'att-stale'), { recursive: true })

    const attachmentResult = await pruneStaleThreadAttachmentDirs(dataDir, db)

    assert.equal(attachmentResult.removed, 1)
    assert.equal(existsSync(attachmentDir(dataDir, threadId, 'att-stale')), false)
    assert.equal(existsSync(attachmentDir(dataDir, threadId, attachmentId)), true)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('janitor wipes legacy runtimes tree (no longer per-task)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-task-runtime-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-running', 'running')
    const legacyJobRoot = jobRuntimeDir(dataDir, 'thread-1', 'job-running')
    mkdirSync(join(legacyJobRoot, 'tasks', 'task-completed', 'opencode', 'cache'), {
      recursive: true
    })
    mkdirSync(join(legacyJobRoot, 'tasks', 'task-running', 'opencode', 'cache'), {
      recursive: true
    })
    writeFileSync(join(legacyJobRoot, 'tasks', 'task-completed', 'opencode', 'cache', 'a.bin'), '1')
    writeFileSync(join(legacyJobRoot, 'tasks', 'task-running', 'opencode', 'cache', 'b.bin'), '2')

    const result = await wipeLegacyProductRuntimes(dataDir)

    assert.equal(result.removed, 1)
    assert.equal(existsSync(join(dataDir, 'runtimes')), false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('sqlite maintenance runs incrementally and respects throttle', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-sqlite-'))
  const db = createIsolatedTestDatabase(dataDir)
  const store = new SettingsStore(dataDir)
  try {
    const maintenance = runSqliteMaintenance(db)
    assert.equal(maintenance.checkpointed, true)

    const now = Math.floor(Date.now() / 1000)
    assert.equal(
      shouldRunSqliteMaintenance(
        store,
        { ...DEFAULT_RETENTION_SETTINGS, sqliteMaintenanceIntervalHours: 24 },
        now
      ),
      true
    )

    const first = runSqliteMaintenanceIfDue({
      db,
      store,
      settings: { ...DEFAULT_RETENTION_SETTINGS, sqliteMaintenanceIntervalHours: 24 }
    })
    assert.equal(first.ran, true)

    const second = runSqliteMaintenanceIfDue({
      db,
      store,
      settings: { ...DEFAULT_RETENTION_SETTINGS, sqliteMaintenanceIntervalHours: 24 }
    })
    assert.equal(second.ran, false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('deleting job row cascades artifact metadata; purgeJobFilesystem clears runtime only', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-cascade-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-cascade', 'completed')
    await putJobArtifact({
      db,
      dataDir,
      jobId: 'job-cascade',
      taskId: 't1',
      kind: 'task_evidence',
      payload: {
        status: 'completed',
        summary: 'done',
        changedFiles: [],
        evidence: ['line'],
        validation: { ran: true, outcome: 'passed' }
      },
      settings: { ...DEFAULT_RETENTION_SETTINGS, artifactInlineMaxBytes: 16 }
    })

    const runtimeDir = join(dataDir, 'runtimes', 'thread-1', 'jobs', 'job-cascade')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'state.json'), '{}')

    await db.delete(jobArtifacts).where(eq(jobArtifacts.jobId, 'job-cascade'))
    const rows = await db.select().from(jobArtifacts)
    assert.equal(rows.length, 0)
    assert.equal(existsSync(runtimeDir), true)

    await purgeJobFilesystem(dataDir, 'thread-1', 'job-cascade')
    assert.equal(existsSync(runtimeDir), false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})
