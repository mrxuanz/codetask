import type Database from 'better-sqlite3'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAssetStoragePath } from '../data-paths'

export type AssetOwnerType = 'conversation' | 'thread' | 'draft' | 'job'

export type RegisterAttachmentAssetInput = {
  assetId: string
  ownerType: AssetOwnerType
  ownerId: string
  storageKey: string
  sizeBytes: number
  sha256?: string | null
  purpose?: string
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined
  return Boolean(row)
}

/** Upsert asset + polymorphic owner reference (Batch G). */
export function registerAttachmentAsset(
  db: Database.Database,
  input: RegisterAttachmentAssetInput
): void {
  if (!tableExists(db, 'assets') || !tableExists(db, 'asset_references')) return

  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO assets
       (id, storage_key, size_bytes, sha256, created_at, updated_at, state, delete_attempts, last_delete_error)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 0, NULL)
     ON CONFLICT(id) DO UPDATE SET
       storage_key = excluded.storage_key,
       size_bytes = excluded.size_bytes,
       sha256 = COALESCE(excluded.sha256, assets.sha256),
       updated_at = excluded.updated_at,
       state = 'active'`
  ).run(input.assetId, input.storageKey, input.sizeBytes, input.sha256 ?? null, now, now)

  db.prepare(
    `INSERT OR IGNORE INTO asset_references
       (asset_id, owner_type, owner_id, purpose, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(input.assetId, input.ownerType, input.ownerId, input.purpose ?? 'attachment', now)
}

export function getAssetOwnerUsage(
  db: Database.Database,
  ownerType: AssetOwnerType,
  ownerId: string
): { count: number; sizeBytes: number } {
  if (!tableExists(db, 'assets') || !tableExists(db, 'asset_references')) {
    return { count: 0, sizeBytes: 0 }
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS size_bytes
         FROM assets
        WHERE state = 'active'
          AND id IN (
            SELECT asset_id FROM asset_references
             WHERE owner_type = ? AND owner_id = ?
          )`
    )
    .get(ownerType, ownerId) as { count: number; size_bytes: number } | undefined
  return { count: row?.count ?? 0, sizeBytes: row?.size_bytes ?? 0 }
}

/** Add another logical owner without copying the underlying file. */
export function retainAssetReference(
  db: Database.Database,
  input: {
    assetId: string
    ownerType: AssetOwnerType
    ownerId: string
    purpose?: string
  }
): void {
  if (!tableExists(db, 'assets') || !tableExists(db, 'asset_references')) return
  const asset = db
    .prepare(`SELECT id FROM assets WHERE id = ? AND state = 'active'`)
    .get(input.assetId) as { id: string } | undefined
  if (!asset) throw new Error(`Attachment asset ${input.assetId} does not exist`)
  db.prepare(
    `INSERT OR IGNORE INTO asset_references
       (asset_id, owner_type, owner_id, purpose, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    input.assetId,
    input.ownerType,
    input.ownerId,
    input.purpose ?? 'attachment',
    Math.floor(Date.now() / 1000)
  )
}

/** Release one logical reference and queue physical deletion when it was the last owner. */
export function releaseAssetReference(
  db: Database.Database,
  input: {
    assetId: string
    ownerType: AssetOwnerType
    ownerId: string
    purpose?: string
  }
): void {
  if (!tableExists(db, 'asset_references')) return
  if (input.purpose) {
    db.prepare(
      `DELETE FROM asset_references
        WHERE asset_id = ? AND owner_type = ? AND owner_id = ? AND purpose = ?`
    ).run(input.assetId, input.ownerType, input.ownerId, input.purpose)
  } else {
    db.prepare(
      `DELETE FROM asset_references
        WHERE asset_id = ? AND owner_type = ? AND owner_id = ?`
    ).run(input.assetId, input.ownerType, input.ownerId)
  }
  markAssetPendingDelete(db, input.assetId)
}

export function resolveRegisteredAssetFile(
  db: Database.Database,
  dataDir: string,
  assetId: string
): string | null {
  if (!tableExists(db, 'assets')) return null
  const row = db
    .prepare(`SELECT storage_key AS storageKey FROM assets WHERE id = ? AND state = 'active'`)
    .get(assetId) as { storageKey: string } | undefined
  if (!row) return null
  const storagePath = resolveAssetStoragePath(dataDir, row.storageKey)
  if (!existsSync(storagePath)) return null
  const entries = readdirSync(storagePath, { withFileTypes: true })
  const file = entries.find((entry) => entry.isFile() && !entry.isSymbolicLink())
  return file ? join(storagePath, file.name) : null
}

/**
 * Raw draft uploads initially have a Conversation owner only. Once the draft has
 * committed its reference, keep the Conversation owner only when a chat message
 * also references the same asset.
 */
export function releaseUnattachedConversationReferences(
  db: Database.Database,
  assetId: string
): void {
  if (!tableExists(db, 'asset_references')) return
  const messageUse = tableExists(db, 'conversation_message_attachments')
    ? (db
        .prepare(`SELECT 1 AS ok FROM conversation_message_attachments WHERE asset_id = ? LIMIT 1`)
        .get(assetId) as { ok: number } | undefined)
    : undefined
  if (messageUse) return
  db.prepare(`DELETE FROM asset_references WHERE asset_id = ? AND owner_type = 'conversation'`).run(
    assetId
  )
  markAssetPendingDelete(db, assetId)
}

export function listAssetOwnerIds(db: Database.Database, ownerType?: AssetOwnerType): string[] {
  if (!tableExists(db, 'asset_references')) return []
  if (ownerType) {
    return (
      db
        .prepare(`SELECT DISTINCT owner_id AS ownerId FROM asset_references WHERE owner_type = ?`)
        .all(ownerType) as Array<{ ownerId: string }>
    ).map((row) => row.ownerId)
  }
  return (
    db.prepare(`SELECT DISTINCT owner_id AS ownerId FROM asset_references`).all() as Array<{
      ownerId: string
    }>
  ).map((row) => row.ownerId)
}

export function markAssetPendingDelete(db: Database.Database, assetId: string): void {
  if (!tableExists(db, 'assets')) return
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `UPDATE assets
        SET state = 'pending_delete', updated_at = ?
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM asset_references WHERE asset_id = ?
        )`
  ).run(now, assetId, assetId)
}

/** Drop all asset_references for an owner, then mark orphaned assets pending_delete. */
export function releaseOwnerAssetReferences(
  db: Database.Database,
  ownerType: AssetOwnerType,
  ownerId: string
): string[] {
  if (!tableExists(db, 'asset_references')) return []
  const assetIds = (
    db
      .prepare(
        `SELECT DISTINCT asset_id AS assetId
           FROM asset_references
          WHERE owner_type = ? AND owner_id = ?`
      )
      .all(ownerType, ownerId) as Array<{ assetId: string }>
  ).map((row) => row.assetId)

  db.prepare(`DELETE FROM asset_references WHERE owner_type = ? AND owner_id = ?`).run(
    ownerType,
    ownerId
  )

  for (const assetId of assetIds) {
    markAssetPendingDelete(db, assetId)
  }
  return assetIds
}

export function listPendingDeleteAssets(
  db: Database.Database
): Array<{ id: string; storageKey: string; deleteAttempts: number }> {
  if (!tableExists(db, 'assets')) return []
  return db
    .prepare(
      `SELECT id, storage_key AS storageKey, delete_attempts AS deleteAttempts
         FROM assets
        WHERE state = 'pending_delete'
        ORDER BY updated_at ASC
        LIMIT 100`
    )
    .all() as Array<{ id: string; storageKey: string; deleteAttempts: number }>
}

export function markAssetDeleteFailed(db: Database.Database, assetId: string, error: string): void {
  if (!tableExists(db, 'assets')) return
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `UPDATE assets
        SET delete_attempts = delete_attempts + 1,
            last_delete_error = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(error.slice(0, 500), now, assetId)
}

export function finalizeAssetDeleted(db: Database.Database, assetId: string): void {
  if (!tableExists(db, 'assets')) return
  db.prepare(`DELETE FROM assets WHERE id = ?`).run(assetId)
}
