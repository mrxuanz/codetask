import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { JobEventBus } from '../../src/server/context/event-bus'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import {
  draftReferences,
  jobArtifacts,
  jobTasks,
  projects,
  threadJobs,
  threadMessages,
  threads
} from '../../src/server/db/schema'
import { SettingsStore } from '../../src/server/context/settings-store'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import {
  pruneCompletedTaskRuntimeTrees,
  pruneOrphanDesignArtifactDirs,
  pruneStaleThreadAttachmentDirs
} from '../../src/server/retention/janitor'
import { estimateJobRuntimeBytes, jobTaskRuntimeDir } from '../../src/server/runtime/cleanup'
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
  dataPaths,
  designArtifactDir,
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
    username: 'user',
    title: 'P',
    workspaceRoot: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })

  await db.insert(threads).values({
    id: threadId,
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
    id: messageId,
    threadId,
    username: 'user',
    role: 'assistant',
    kind: 'task-launch-draft',
    content: '{}',
    coreCode: 'cursor',
    conversationId: 'conv-1',
    attachmentsJson: JSON.stringify([{ id: attachmentId, name: 'ref.png' }]),
    createdAt: new Date().toISOString()
  })

  await db.insert(threadMessages).values({
    id: execMessageId,
    threadId,
    username: 'user',
    role: 'assistant',
    kind: 'task-launch-draft',
    content: '{}',
    coreCode: 'cursor',
    conversationId: 'conv-1',
    createdAt: new Date().toISOString()
  })

  // Planning job (designSessionId) — status planning/plan_editing; distinct draftMessageId
  await db.insert(threadJobs).values({
    id: designSessionId,
    threadId,
    username: 'user',
    draftMessageId: messageId,
    title: 'Design',
    summary: '',
    status: 'plan_editing',
    workspacePath: '/tmp/ws',
    phase: 'draft_review',
    draftRevision: 1,
    planRevision: 0,
    createdAt: now,
    updatedAt: now
  })

  await db.insert(draftReferences).values({
    id: 'ref-1',
    designSessionId,
    source: 'attachment',
    name: 'ref',
    kind: 'image',
    description: 'layout',
    attachmentId,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  })

  // Separate execution job — must use a different draftMessageId (unique thread_id, draft_message_id)
  await db.insert(threadJobs).values({
    id: jobId,
    threadId,
    username: 'user',
    draftMessageId: execMessageId,
    title: 'Job',
    summary: '',
    status: 'completed',
    workspacePath: '/tmp/ws',
    createdAt: now,
    updatedAt: now
  })

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

test('purgeThreadFilesystem removes attachments, design artifacts, and message artifacts', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-thread-purge-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const { threadId, designSessionId, messageId, attachmentId } = await seedThreadGraph(db)
    const targets = await collectThreadPurgeTargets(db, threadId)

    mkdirSync(attachmentDir(dataDir, threadId, attachmentId), { recursive: true })
    writeFileSync(join(attachmentDir(dataDir, threadId, attachmentId), 'ref.png'), 'png')
    mkdirSync(designArtifactDir(dataDir, designSessionId), { recursive: true })
    writeFileSync(join(designArtifactDir(dataDir, designSessionId), 'plan-v1.json.gz'), 'gz')
    mkdirSync(messageArtifactDir(dataDir, messageId), { recursive: true })
    writeFileSync(join(messageArtifactDir(dataDir, messageId), 'payload.json.gz'), 'gz')
    mkdirSync(join(dataPaths(dataDir).runtimes, threadId), { recursive: true })

    await purgeThreadFilesystem(dataDir, threadId, targets)

    assert.equal(existsSync(threadAttachmentsDir(dataDir, threadId)), false)
    assert.equal(existsSync(designArtifactDir(dataDir, designSessionId)), false)
    assert.equal(existsSync(messageArtifactDir(dataDir, messageId)), false)
    assert.equal(existsSync(join(dataPaths(dataDir).runtimes, threadId)), false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('janitor prunes orphan design artifacts and stale attachment dirs', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-janitor-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const { threadId, designSessionId, attachmentId } = await seedThreadGraph(db)

    mkdirSync(designArtifactDir(dataDir, 'orphan-design'), { recursive: true })
    mkdirSync(designArtifactDir(dataDir, designSessionId), { recursive: true })
    mkdirSync(attachmentDir(dataDir, threadId, attachmentId), { recursive: true })
    mkdirSync(attachmentDir(dataDir, threadId, 'att-stale'), { recursive: true })

    const [designResult, attachmentResult] = await Promise.all([
      pruneOrphanDesignArtifactDirs(dataDir, db),
      pruneStaleThreadAttachmentDirs(dataDir, db)
    ])

    assert.equal(designResult.removed, 1)
    assert.equal(attachmentResult.removed, 1)
    assert.equal(existsSync(designArtifactDir(dataDir, 'orphan-design')), false)
    assert.equal(existsSync(attachmentDir(dataDir, threadId, 'att-stale')), false)
    assert.equal(existsSync(attachmentDir(dataDir, threadId, attachmentId)), true)
    assert.equal(existsSync(designArtifactDir(dataDir, designSessionId)), true)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('janitor removes only completed task runtimes from a running job', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-m6-task-runtime-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedMinimalJob(db, 'job-running', 'running')
    await db.insert(jobTasks).values([
      {
        jobId: 'job-running',
        taskId: 'task-completed',
        title: 'Completed task',
        sortOrder: 0,
        status: 'completed'
      },
      {
        jobId: 'job-running',
        taskId: 'task-running',
        title: 'Running task',
        sortOrder: 1,
        status: 'running'
      },
      {
        jobId: 'job-running',
        taskId: '../outside-task-root',
        title: 'Invalid historical task id',
        sortOrder: 2,
        status: 'completed'
      }
    ])

    const completedRuntime = jobTaskRuntimeDir(dataDir, 'thread-1', 'job-running', 'task-completed')
    const runningRuntime = jobTaskRuntimeDir(dataDir, 'thread-1', 'job-running', 'task-running')
    mkdirSync(join(completedRuntime, 'opencode', 'cache', 'nested'), { recursive: true })
    mkdirSync(join(runningRuntime, 'opencode', 'cache'), { recursive: true })
    const outsideTaskRoot = join(
      dataDir,
      'runtimes',
      'thread-1',
      'jobs',
      'job-running',
      'outside-task-root'
    )
    mkdirSync(outsideTaskRoot, { recursive: true })
    writeFileSync(join(completedRuntime, 'opencode', 'cache', 'nested', 'cache.bin'), '12345')
    writeFileSync(join(runningRuntime, 'opencode', 'cache', 'cache.bin'), '1234567')
    writeFileSync(join(outsideTaskRoot, 'keep.bin'), '123')

    // Runtime accounting must include files nested more than one directory deep.
    assert.equal(await estimateJobRuntimeBytes(dataDir, 'thread-1', 'job-running'), 15)

    const result = await pruneCompletedTaskRuntimeTrees(dataDir, db)

    assert.equal(result.removed, 1)
    assert.equal(existsSync(completedRuntime), false)
    assert.equal(existsSync(runningRuntime), true)
    assert.equal(existsSync(outsideTaskRoot), true)
    assert.equal(await estimateJobRuntimeBytes(dataDir, 'thread-1', 'job-running'), 10)
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

test('JobEventBus clearJob drops SSE listeners', () => {
  const bus = new JobEventBus()
  let hits = 0
  const unsubscribe = bus.subscribe('job-1', () => {
    hits += 1
  })

  bus.emit('job-1', { event: 'task_progress', data: { taskProgress: {} as never } })
  assert.equal(hits, 1)

  unsubscribe()
  bus.clearJob('job-1')
  bus.emit('job-1', { event: 'task_progress', data: { taskProgress: {} as never } })
  assert.equal(hits, 1)
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

    await db.delete(threadJobs).where(eq(threadJobs.id, 'job-cascade'))
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
