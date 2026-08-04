import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migration048ConversationModuleTables } from '../../packages/database/src/migrations/conversation.ts'
import { migration062AssetsAndDropDeadRuntimeTables } from '../../packages/database/src/migrations/assets-and-drop-dead-runtime.ts'
import { registerAttachmentAsset, listAssetOwnerIds } from '../../src/server/assets/registry'

test('migration 062 drops dead tables, creates assets, and backfills conversation attachments', () => {
  const db = new Database(':memory:')
  migration048ConversationModuleTables.up(db)
  db.prepare(
    `INSERT INTO conversation_threads
       (id, actor_id, project_id, title, title_source, provider_code, state, state_revision, created_at, updated_at)
     VALUES ('conv-1', 'u1', 'p1', 't', 'auto', 'cursor', 'active', 0, 't', 't')`
  ).run()
  db.prepare(
    `INSERT INTO conversation_message_attachments
       (id, message_id, conversation_id, asset_id, name, mime_type, size_bytes, kind, sort_order, created_at)
     VALUES ('row-1', NULL, 'conv-1', 'att-1', 'a.png', 'image/png', 12, 'image', 0, 't')`
  ).run()

  assert.equal(
    Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE name='conversation_outbox'`).get()),
    true
  )

  migration062AssetsAndDropDeadRuntimeTables.up(db)

  assert.equal(
    Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE name='conversation_outbox'`).get()),
    false
  )
  assert.equal(
    Boolean(db.prepare(`SELECT name FROM sqlite_master WHERE name='agent_runtime_bindings'`).get()),
    false
  )

  const asset = db
    .prepare(`SELECT id, storage_key, state FROM assets WHERE id = ?`)
    .get('att-1') as { id: string; storage_key: string; state: string } | undefined
  assert.equal(asset?.id, 'att-1')
  assert.equal(asset?.state, 'active')
  assert.match(asset?.storage_key ?? '', /conv-1/)

  const ref = db
    .prepare(
      `SELECT owner_type AS ownerType, owner_id AS ownerId FROM asset_references WHERE asset_id = ?`
    )
    .get('att-1') as { ownerType: string; ownerId: string } | undefined
  assert.equal(ref?.ownerType, 'conversation')
  assert.equal(ref?.ownerId, 'conv-1')
  db.close()
})

test('registerAttachmentAsset upserts asset and owner reference', () => {
  const db = new Database(':memory:')
  migration062AssetsAndDropDeadRuntimeTables.up(db)
  registerAttachmentAsset(db, {
    assetId: 'att-x',
    ownerType: 'conversation',
    ownerId: 'conv-x',
    storageKey: 'attachments/conv-x/att-x/file.png',
    sizeBytes: 9
  })
  assert.deepEqual(listAssetOwnerIds(db, 'conversation'), ['conv-x'])
  db.close()
})
