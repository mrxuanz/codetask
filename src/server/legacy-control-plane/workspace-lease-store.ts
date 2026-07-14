import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { getAppContext } from '../bootstrap'
import { getDb, type AppDatabase } from '../db'
import { workspaceLeases } from '../db/schema'
import { canonicalizePath } from '../sandbox/paths'
import { workloadLeaseTtlSec } from './workload-slot-store'

export type WorkspaceLeaseOwnerKind = 'conversation' | 'planner' | 'thread_job'

export interface WorkspaceLeaseOccupant {
  leaseId: string
  ownerKind: WorkspaceLeaseOwnerKind
  ownerId: string
  runId: string | null
  canonicalPath: string
}

export interface AcquireWorkspaceLeaseInput {
  workspacePath: string
  ownerKind: WorkspaceLeaseOwnerKind
  ownerId: string
  runId?: string | null
}

export interface AcquireWorkspaceLeaseResult {
  leaseId: string
  canonicalPath: string
}

export interface ReleaseWorkspaceLeaseInput {
  leaseId: string
  runId?: string | null
}

const activeLeaseByOwner = new Map<string, string>()

function ownerKey(ownerKind: WorkspaceLeaseOwnerKind, ownerId: string): string {
  return `${ownerKind}:${ownerId}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function getSqliteClient(db: AppDatabase = getDb()): Database.Database {
  const client = (db as AppDatabase & { $client?: Database.Database }).$client
  if (!client) {
    throw new Error('SQLite client unavailable')
  }
  return client
}

export function workspaceLeaseTtlSec(): number {
  return workloadLeaseTtlSec()
}

export function normalizeWorkspaceLeasePath(workspacePath: string): string {
  return canonicalizePath(workspacePath.trim())
}

/** Same path, parent directory, or child directory counts as a conflict. */
export function workspacePathsConflict(left: string, right: string): boolean {
  const normLeft = left.replace(/\\/g, '/').toLowerCase()
  const normRight = right.replace(/\\/g, '/').toLowerCase()
  if (normLeft === normRight) return true
  const prefixLeft = normLeft.endsWith('/') ? normLeft : `${normLeft}/`
  const prefixRight = normRight.endsWith('/') ? normRight : `${normRight}/`
  return prefixLeft.startsWith(prefixRight) || prefixRight.startsWith(prefixLeft)
}

function parseActiveLeaseRows(
  rows: Array<{
    id: string
    canonicalPath: string
    ownerKind: string
    ownerId: string
    runId: string | null
  }>
): WorkspaceLeaseOccupant[] {
  return rows.map((row) => ({
    leaseId: row.id,
    ownerKind: row.ownerKind as WorkspaceLeaseOwnerKind,
    ownerId: row.ownerId,
    runId: row.runId,
    canonicalPath: row.canonicalPath
  }))
}

function findConflictingOccupant(
  canonicalPath: string,
  activeRows: WorkspaceLeaseOccupant[],
  excludeOwner?: { ownerKind: WorkspaceLeaseOwnerKind; ownerId: string }
): WorkspaceLeaseOccupant | null {
  for (const row of activeRows) {
    if (
      excludeOwner &&
      row.ownerKind === excludeOwner.ownerKind &&
      row.ownerId === excludeOwner.ownerId
    ) {
      continue
    }
    if (workspacePathsConflict(canonicalPath, row.canonicalPath)) {
      return row
    }
  }
  return null
}

function cleanStaleWorkspaceLeasesTx(client: Database.Database, now: number): void {
  client
    .prepare(
      `UPDATE workspace_leases
       SET status = 'released', released_at = ?
       WHERE status = 'active' AND lease_expires_at <= ?`
    )
    .run(now, now)
}

function listActiveLeaseRowsTx(client: Database.Database): WorkspaceLeaseOccupant[] {
  const rows = client
    .prepare(
      `SELECT id, canonical_path AS canonicalPath, owner_kind AS ownerKind,
              owner_id AS ownerId, run_id AS runId
       FROM workspace_leases
       WHERE status = 'active'`
    )
    .all() as Array<{
    id: string
    canonicalPath: string
    ownerKind: string
    ownerId: string
    runId: string | null
  }>
  return parseActiveLeaseRows(rows)
}

function runImmediateTransaction<T>(client: Database.Database, fn: () => T): T {
  client.prepare('BEGIN IMMEDIATE').run()
  try {
    const result = fn()
    client.prepare('COMMIT').run()
    return result
  } catch (error) {
    try {
      client.prepare('ROLLBACK').run()
    } catch {
      // ignore rollback failure
    }
    throw error
  }
}

export function acquireWorkspaceLease(
  input: AcquireWorkspaceLeaseInput
): AcquireWorkspaceLeaseResult | null {
  const canonicalPath = normalizeWorkspaceLeasePath(input.workspacePath)
  const now = nowSec()
  const bootId = getAppContext().bootId
  const leaseExpiresAt = now + workspaceLeaseTtlSec()
  const leaseId = `wlease-${randomUUID()}`
  const client = getSqliteClient()

  const acquired = runImmediateTransaction(client, () => {
    cleanStaleWorkspaceLeasesTx(client, now)
    const activeRows = listActiveLeaseRowsTx(client)
    const conflict = findConflictingOccupant(canonicalPath, activeRows, {
      ownerKind: input.ownerKind,
      ownerId: input.ownerId
    })
    if (conflict) return null

    const existing = activeRows.find(
      (row) => row.ownerKind === input.ownerKind && row.ownerId === input.ownerId
    )
    if (existing) {
      client
        .prepare(
          `UPDATE workspace_leases
           SET canonical_path = ?, run_id = ?, boot_id = ?, lease_expires_at = ?
           WHERE id = ? AND status = 'active'`
        )
        .run(
          canonicalPath,
          input.runId ?? null,
          bootId,
          leaseExpiresAt,
          existing.leaseId
        )
      activeLeaseByOwner.set(ownerKey(input.ownerKind, input.ownerId), existing.leaseId)
      return { leaseId: existing.leaseId, canonicalPath }
    }

    client
      .prepare(
        `INSERT INTO workspace_leases (
          id, canonical_path, owner_kind, owner_id, run_id, boot_id,
          status, lease_expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(
        leaseId,
        canonicalPath,
        input.ownerKind,
        input.ownerId,
        input.runId ?? null,
        bootId,
        leaseExpiresAt,
        now
      )
    activeLeaseByOwner.set(ownerKey(input.ownerKind, input.ownerId), leaseId)
    return { leaseId, canonicalPath }
  })

  return acquired
}

export function refreshWorkspaceLease(leaseId: string): void {
  const now = nowSec()
  const bootId = getAppContext().bootId
  const leaseExpiresAt = now + workspaceLeaseTtlSec()
  getDb()
    .update(workspaceLeases)
    .set({ bootId, leaseExpiresAt })
    .where(and(eq(workspaceLeases.id, leaseId), eq(workspaceLeases.status, 'active')))
    .run()
}

export function refreshWorkspaceLeaseForOwner(
  ownerKind: WorkspaceLeaseOwnerKind,
  ownerId: string
): void {
  const leaseId = activeLeaseByOwner.get(ownerKey(ownerKind, ownerId))
  if (!leaseId) return
  refreshWorkspaceLease(leaseId)
}

export function releaseWorkspaceLease(input: string | ReleaseWorkspaceLeaseInput): boolean {
  const leaseId = typeof input === 'string' ? input : input.leaseId
  const expectedRunId = typeof input === 'string' ? undefined : input.runId
  const now = nowSec()
  const rows = getDb()
    .select({
      ownerKind: workspaceLeases.ownerKind,
      ownerId: workspaceLeases.ownerId,
      runId: workspaceLeases.runId,
      status: workspaceLeases.status
    })
    .from(workspaceLeases)
    .where(eq(workspaceLeases.id, leaseId))
    .limit(1)
    .all()
  const row = rows[0]
  if (!row || row.status !== 'active') {
    return false
  }
  if (expectedRunId !== undefined && row.runId !== expectedRunId) {
    return false
  }

  activeLeaseByOwner.delete(ownerKey(row.ownerKind as WorkspaceLeaseOwnerKind, row.ownerId))

  const result = getDb()
    .update(workspaceLeases)
    .set({ status: 'released', releasedAt: now })
    .where(
      and(
        eq(workspaceLeases.id, leaseId),
        eq(workspaceLeases.status, 'active'),
        ...(expectedRunId !== undefined ? [eq(workspaceLeases.runId, expectedRunId)] : [])
      )
    )
    .run()
  return result.changes > 0
}

export function releaseWorkspaceLeaseForOwner(
  ownerKind: WorkspaceLeaseOwnerKind,
  ownerId: string
): void {
  const leaseId = activeLeaseByOwner.get(ownerKey(ownerKind, ownerId))
  if (leaseId) {
    releaseWorkspaceLease(leaseId)
    return
  }

  const rows = getDb()
    .select({ id: workspaceLeases.id })
    .from(workspaceLeases)
    .where(
      and(
        eq(workspaceLeases.ownerKind, ownerKind),
        eq(workspaceLeases.ownerId, ownerId),
        eq(workspaceLeases.status, 'active')
      )
    )
    .all()
  for (const row of rows) {
    releaseWorkspaceLease(row.id)
  }
  activeLeaseByOwner.delete(ownerKey(ownerKind, ownerId))
}

/** Release every active workspace lease (tests / drain cleanup). */
export function releaseAllActiveWorkspaceLeases(): void {
  const rows = getDb()
    .select({ id: workspaceLeases.id })
    .from(workspaceLeases)
    .where(eq(workspaceLeases.status, 'active'))
    .all()
  for (const row of rows) {
    releaseWorkspaceLease(row.id)
  }
  activeLeaseByOwner.clear()
}

export function findWorkspaceLeaseConflict(
  workspacePath: string,
  excludeOwner?: { ownerKind: WorkspaceLeaseOwnerKind; ownerId: string }
): WorkspaceLeaseOccupant | null {
  const canonicalPath = normalizeWorkspaceLeasePath(workspacePath)
  const client = getSqliteClient()
  const now = nowSec()

  return runImmediateTransaction(client, () => {
    cleanStaleWorkspaceLeasesTx(client, now)
    const activeRows = listActiveLeaseRowsTx(client)
    return findConflictingOccupant(canonicalPath, activeRows, excludeOwner)
  })
}

export function reclaimStaleWorkspaceLeasesOnStartup(): number {
  const bootId = getAppContext().bootId
  const now = nowSec()
  const client = getSqliteClient()

  const expired = client
    .prepare(
      `UPDATE workspace_leases
       SET status = 'released', released_at = ?
       WHERE status = 'active' AND lease_expires_at <= ?`
    )
    .run(now, now).changes

  const staleBoot = client
    .prepare(
      `UPDATE workspace_leases
       SET status = 'released', released_at = ?
       WHERE status = 'active' AND boot_id != ?`
    )
    .run(now, bootId).changes

  activeLeaseByOwner.clear()
  return expired + staleBoot
}

export function resetWorkspaceLeaseStateForTests(): void {
  activeLeaseByOwner.clear()
}
