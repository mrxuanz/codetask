import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import { projects } from '../../src/server/db/schema'
import { dataPaths, threadAttachmentsDir } from '../../src/server/data-paths'
import { pruneOrphanAttachments } from '../../src/server/retention/janitor'

function seedProject(
  db: ReturnType<typeof createIsolatedTestDatabase>,
  projectId = 'proj-1'
): void {
  const now = Math.floor(Date.now() / 1000)
  db.insert(projects)
    .values({
      id: projectId,
      actorId: 'user',
      title: 'P',
      workspaceRoot: '/tmp/ws',
      createdAt: now,
      updatedAt: now
    })
    .run()
}

function seedConversation(
  db: ReturnType<typeof createIsolatedTestDatabase>,
  conversationId: string
): void {
  const client = (db as { $client?: import('better-sqlite3').Database }).$client
  assert.ok(client)
  const nowIso = new Date().toISOString()
  client
    .prepare(
      `INSERT INTO conversation_threads (
        id, actor_id, project_id, title, title_source, provider_code,
        state, state_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(conversationId, 'user', 'proj-1', 'Chat', 'manual', 'codex', 'active', 0, nowIso, nowIso)
}

test('pruneOrphanAttachments keeps conversation attachment directories', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'janitor-conv-att-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    seedProject(db)
    const conversationId = `conv_${'b'.repeat(32)}`
    seedConversation(db, conversationId)

    const convDir = threadAttachmentsDir(dataDir, conversationId)
    mkdirSync(join(convDir, 'att-keep'), { recursive: true })
    writeFileSync(join(convDir, 'att-keep', 'file.png'), 'png')

    const orphanId = 'orphan-owner-dir'
    const orphanDir = threadAttachmentsDir(dataDir, orphanId)
    mkdirSync(orphanDir, { recursive: true })
    writeFileSync(join(orphanDir, 'gone.txt'), 'x')

    const result = await pruneOrphanAttachments(dataDir, db)

    assert.equal(existsSync(join(convDir, 'att-keep', 'file.png')), true)
    assert.equal(existsSync(orphanDir), false)
    assert.equal(result.removed >= 1, true)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('pruneOrphanAttachments keeps conversation owner attachment directories', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'janitor-thread-att-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    seedProject(db)
    const threadId = '11111111-1111-4111-8111-111111111111'
    seedConversation(db, threadId)

    const threadDir = threadAttachmentsDir(dataDir, threadId)
    mkdirSync(join(threadDir, 'att-1'), { recursive: true })
    writeFileSync(join(threadDir, 'att-1', 'a.png'), 'png')

    const result = await pruneOrphanAttachments(dataDir, db)
    assert.equal(existsSync(join(threadDir, 'att-1', 'a.png')), true)
    assert.equal(result.removed, 0)
    assert.equal(existsSync(dataPaths(dataDir).attachments), true)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('pruneOrphanAttachments removes true orphan owner directories', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'janitor-orphan-att-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    seedProject(db)
    mkdirSync(dataPaths(dataDir).attachments, { recursive: true })
    const orphanDir = threadAttachmentsDir(dataDir, 'not-a-real-owner')
    mkdirSync(orphanDir, { recursive: true })
    writeFileSync(join(orphanDir, 'x.bin'), 'bin')

    const result = await pruneOrphanAttachments(dataDir, db)
    assert.equal(result.removed, 1)
    assert.equal(existsSync(orphanDir), false)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})
