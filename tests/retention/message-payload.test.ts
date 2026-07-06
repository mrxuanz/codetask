import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_RETENTION_SETTINGS } from '../../src/shared/contracts/retention'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap'
import {
  getMessage,
  insertMessage,
  updateMessagePayload
} from '../../src/server/conversation/messages'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase, getDb } from '../../src/server/db'
import { projects, threadMessages, threads } from '../../src/server/db/schema'
import {
  hydrateMessagePayload,
  prepareMessagePayloadForStorage,
  shouldExternalizeMessagePayload
} from '../../src/server/retention/message-payload'

async function seedThread(db: ReturnType<typeof getDb>): Promise<void> {
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
}

test('shouldExternalizeMessagePayload when draft payload exceeds inline limit', () => {
  const payload = {
    draftId: 'd1',
    title: 'Draft',
    summary: 's',
    requirementsContract: { markdown: 'x'.repeat(9000), status: 'pending' }
  }
  assert.equal(shouldExternalizeMessagePayload(payload, 2048), true)
})

test('prepareMessagePayloadForStorage externalizes and hydrates round-trip', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-msg-payload-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    await seedThread(db)
    await db.insert(threadMessages).values({
      id: 'msg-1',
      threadId: 'thread-1',
      username: 'user',
      role: 'assistant',
      kind: 'task-launch-draft',
      content: 'draft',
      coreCode: 'cursor',
      conversationId: 'conv-1',
      createdAt: new Date().toISOString()
    })

    const fullPayload = {
      draftId: 'd1',
      sourceMessageId: 'msg-1',
      title: 'Large draft',
      summary: 'summary',
      status: 'editing',
      requirementsContract: { markdown: 'x'.repeat(9000), status: 'pending' },
      acceptance: [{ id: 'a1', given: 'g', when: 'w', then: 't' }]
    }

    const stored = await prepareMessagePayloadForStorage({
      messageId: 'msg-1',
      payload: fullPayload,
      dataDir,
      db,
      settings: { ...DEFAULT_RETENTION_SETTINGS, messagePayloadInlineMaxBytes: 1024 }
    })

    assert.ok(stored.payloadArtifactId)
    assert.ok(stored.payloadJson)
    assert.doesNotMatch(stored.payloadJson!, /xxxx/)

    const hydrated = (await hydrateMessagePayload({
      payloadJson: stored.payloadJson,
      payloadArtifactId: stored.payloadArtifactId,
      dataDir,
      db
    })) as typeof fullPayload

    assert.equal(hydrated.title, 'Large draft')
    assert.equal(hydrated.requirementsContract.markdown.length, 9000)
    assert.equal(hydrated.acceptance.length, 1)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('insertMessage externalizes large draft payload without FK violation', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-insert-msg-'))
  await resetAppContextForTests()
  const ctx = bootstrapRuntime({ dataDir })
  try {
    await seedThread(ctx.db)
    const fullPayload = {
      draftId: 'd1',
      sourceMessageId: 'msg-src',
      title: 'Large draft',
      summary: 'summary',
      status: 'editing',
      requirementsContract: { markdown: 'x'.repeat(9000), status: 'pending' },
      acceptance: [{ id: 'a1', given: 'g', when: 'w', then: 't' }]
    }

    const message = await insertMessage({
      threadId: 'thread-1',
      username: 'user',
      role: 'assistant',
      kind: 'task-launch-draft',
      content: 'Large draft',
      coreCode: 'cursor',
      conversationId: 'conv-1',
      payload: fullPayload
    })

    const hydrated = message.payload as typeof fullPayload
    assert.equal(hydrated.requirementsContract.markdown.length, 9000)
    assert.equal(hydrated.acceptance.length, 1)
  } finally {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('message payload storage strips asset auth query tokens', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-msg-token-clean-'))
  await resetAppContextForTests()
  const ctx = bootstrapRuntime({ dataDir })
  try {
    await seedThread(ctx.db)
    const dirtyAssetUrl =
      '/api/threads/thread-1/attachments/att-1?asset_token=old-token&access_token=session&view=1#preview'
    const cleanAssetUrl = '/api/threads/thread-1/attachments/att-1?view=1#preview'

    const message = await insertMessage({
      id: 'msg-token-clean',
      threadId: 'thread-1',
      username: 'user',
      role: 'assistant',
      kind: 'task-launch-draft',
      content: 'Draft',
      coreCode: 'cursor',
      conversationId: 'conv-1',
      payload: {
        draftId: 'd1',
        references: [{ id: 'att-1', assetUrl: dirtyAssetUrl }],
        nested: { thumbnailUrl: dirtyAssetUrl }
      },
      attachments: [
        {
          id: 'att-1',
          name: 'ref.png',
          mimeType: 'image/png',
          sizeBytes: 3,
          kind: 'image',
          relativePath: 'att-1/ref.png',
          assetUrl: dirtyAssetUrl
        }
      ]
    })

    const payload = message.payload as {
      references: Array<{ assetUrl: string }>
      nested: { thumbnailUrl: string }
    }
    assert.match(payload.references[0]!.assetUrl, /asset_token=/)
    assert.doesNotMatch(payload.references[0]!.assetUrl, /old-token|access_token=/)
    assert.match(payload.nested.thumbnailUrl, /asset_token=/)

    const raw = await getMessage('user', 'thread-1', 'msg-token-clean', {
      signAssets: false
    })
    const rawPayload = raw?.payload as {
      references: Array<{ assetUrl: string }>
      nested: { thumbnailUrl: string }
    }
    assert.equal(rawPayload.references[0]!.assetUrl, cleanAssetUrl)
    assert.equal(rawPayload.nested.thumbnailUrl, cleanAssetUrl)
    assert.equal(raw?.attachments[0]?.assetUrl, cleanAssetUrl)

    await updateMessagePayload('user', 'thread-1', 'msg-token-clean', {
      draftId: 'd1',
      references: [{ id: 'att-1', assetUrl: dirtyAssetUrl }]
    })

    const rows = await ctx.db
      .select({
        payloadJson: threadMessages.payloadJson,
        attachmentsJson: threadMessages.attachmentsJson
      })
      .from(threadMessages)
      .where(eq(threadMessages.id, 'msg-token-clean'))
      .limit(1)

    assert.equal(rows.length, 1)
    assert.doesNotMatch(rows[0]!.payloadJson ?? '', /asset_token|access_token|old-token/)
    assert.doesNotMatch(rows[0]!.attachmentsJson ?? '', /asset_token|access_token|old-token/)
  } finally {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
