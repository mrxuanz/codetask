import { randomUUID } from 'node:crypto'
import { eq, and } from 'drizzle-orm'
import { AppError } from '../error'
import { getAppContext } from '../bootstrap'
import { getDb } from '../db'
import { changeSets, type ChangeSet } from '../db/schema'
import { getProject } from '../projects/service'
import type {
  ChangeSetDto,
  ChangeSetStatus,
  CreateChangeSetAcceptedDto,
  CreateChangeSetInput
} from '../../shared/contracts/change-sets'
import {
  acquireWorkspaceLease,
  releaseWorkspaceLease
} from '../legacy-control-plane/workspace-lease-store'
import { applyPatchToMainWorkspace, buildChangeSetPatch, readStoredPatch } from './patch'
import {
  isGitWorkspace,
  prepareChangeSetWorktree,
  rebaseGitWorktree,
  removeChangeSetWorktree
} from './worktree'

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function parseLastError(json: string | null): ChangeSetDto['lastError'] {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as { code?: unknown; message?: unknown }
    if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
      return { code: parsed.code, message: parsed.message }
    }
  } catch {
    // ignore
  }
  return null
}

export function toChangeSetDto(row: ChangeSet): ChangeSetDto {
  return {
    id: row.id,
    projectId: row.projectId,
    username: row.username,
    sourceThreadId: row.sourceThreadId ?? null,
    sourceTurnId: row.sourceTurnId ?? null,
    status: row.status as ChangeSetStatus,
    baseCommit: row.baseCommit ?? null,
    baseWorkspaceGeneration: row.baseWorkspaceGeneration ?? null,
    worktreePath: row.worktreePath ?? null,
    patchHash: row.patchHash ?? null,
    applyPolicy: row.applyPolicy,
    stateRevision: row.stateRevision,
    lastError: parseLastError(row.lastErrorJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    appliedAt: row.appliedAt ?? null
  }
}

async function getChangeSetRow(username: string, changeSetId: string): Promise<ChangeSet> {
  const db = getDb()
  const rows = await db
    .select()
    .from(changeSets)
    .where(and(eq(changeSets.id, changeSetId), eq(changeSets.username, username)))
    .limit(1)
  const row = rows[0]
  if (!row) {
    throw AppError.notFound('Change set not found', 'change_set.not_found')
  }
  return row
}

function assertRevision(row: ChangeSet, expectedRevision?: number): void {
  if (expectedRevision !== undefined && row.stateRevision !== expectedRevision) {
    throw AppError.conflict('Change set revision conflict', {
      code: 'change_set.revision_conflict',
      expected: expectedRevision,
      actual: row.stateRevision
    })
  }
}

async function updateChangeSet(
  row: ChangeSet,
  patch: {
    status?: ChangeSetStatus
    worktreePath?: string | null
    patchHash?: string | null
    patchArtifactId?: string | null
    validationJson?: string | null
    lastErrorJson?: string | null
    appliedAt?: number | null
    baseCommit?: string | null
    baseWorkspaceGeneration?: string | null
  }
): Promise<ChangeSetDto> {
  const db = getDb()
  const nextRevision = row.stateRevision + 1
  await db
    .update(changeSets)
    .set({
      ...patch,
      stateRevision: nextRevision,
      updatedAt: nowSec()
    })
    .where(and(eq(changeSets.id, row.id), eq(changeSets.stateRevision, row.stateRevision)))
  return getChangeSet(row.username, row.id)
}

export async function getChangeSet(username: string, changeSetId: string): Promise<ChangeSetDto> {
  return toChangeSetDto(await getChangeSetRow(username, changeSetId))
}

/**
 * Create Change Set + isolated worktree (P6 slice-1).
 */
export async function createChangeSet(
  username: string,
  input: CreateChangeSetInput
): Promise<CreateChangeSetAcceptedDto> {
  const project = await getProject(username, input.projectId)
  if (!project) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }

  const id = `cs-${randomUUID()}`
  const now = nowSec()
  const dataDir = getAppContext().dataDir
  const db = getDb()

  await db.insert(changeSets).values({
    id,
    projectId: project.id,
    username,
    sourceThreadId: input.sourceThreadId ?? null,
    sourceTurnId: input.sourceTurnId ?? null,
    status: 'preparing_worktree',
    applyPolicy: input.applyPolicy?.trim() || 'manual',
    stateRevision: 1,
    createdAt: now,
    updatedAt: now
  })

  try {
    const prepared = prepareChangeSetWorktree({
      dataDir,
      changeSetId: id,
      workspaceRoot: project.workspaceRoot
    })

    await db
      .update(changeSets)
      .set({
        status: 'editing',
        worktreePath: prepared.worktreePath,
        baseCommit: prepared.baseCommit,
        baseWorkspaceGeneration: prepared.baseCommit,
        stateRevision: 2,
        updatedAt: nowSec()
      })
      .where(eq(changeSets.id, id))

    return { changeSetId: id, status: 'editing', revision: 2 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db
      .update(changeSets)
      .set({
        status: 'failed',
        lastErrorJson: JSON.stringify({ code: 'change_set.worktree_failed', message }),
        stateRevision: 2,
        updatedAt: nowSec()
      })
      .where(eq(changeSets.id, id))
    removeChangeSetWorktree(dataDir, id, project.workspaceRoot)
    throw AppError.internal(
      `Failed to prepare change-set worktree: ${message}`,
      'change_set.worktree_failed'
    )
  }
}

/**
 * Build patch from worktree edits and mark ready_to_apply (P6 slice-2).
 */
export async function markChangeSetReady(
  username: string,
  changeSetId: string,
  expectedRevision?: number
): Promise<ChangeSetDto> {
  const row = await getChangeSetRow(username, changeSetId)
  assertRevision(row, expectedRevision)

  if (row.status === 'ready_to_apply') {
    return toChangeSetDto(row)
  }
  if (row.status !== 'editing' && row.status !== 'needs_resolution') {
    throw AppError.badRequest(
      `Change set cannot be marked ready from status ${row.status}`,
      'change_set.invalid_status'
    )
  }
  if (!row.worktreePath) {
    throw AppError.badRequest('Change set has no worktree', 'change_set.no_worktree')
  }

  const validatingRow = await getChangeSetRow(username, changeSetId)
  await updateChangeSet(validatingRow, { status: 'validating', lastErrorJson: null })
  const afterValidating = await getChangeSetRow(username, changeSetId)

  try {
    const dataDir = getAppContext().dataDir
    const artifact = buildChangeSetPatch({
      dataDir,
      changeSetId,
      worktreePath: row.worktreePath
    })

    if (artifact.empty) {
      return updateChangeSet(afterValidating, {
        status: 'needs_resolution',
        patchHash: artifact.patchHash,
        patchArtifactId: artifact.patchPath,
        validationJson: JSON.stringify({ reason: 'empty_patch' }),
        lastErrorJson: JSON.stringify({
          code: 'change_set.empty_patch',
          message: 'No file changes in worktree'
        })
      })
    }

    return updateChangeSet(afterValidating, {
      status: 'ready_to_apply',
      patchHash: artifact.patchHash,
      patchArtifactId: artifact.patchPath,
      validationJson: JSON.stringify({ empty: false }),
      lastErrorJson: null
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const current = await getChangeSetRow(username, changeSetId)
    return updateChangeSet(current, {
      status: 'failed',
      lastErrorJson: JSON.stringify({ code: 'change_set.patch_failed', message })
    })
  }
}

/**
 * Apply patch to main workspace under exclusive-write lease (P6 slice-2).
 * Base HEAD mismatch or apply conflict → needs_resolution (never silent overwrite).
 */
export async function applyChangeSet(
  username: string,
  changeSetId: string,
  expectedRevision?: number
): Promise<ChangeSetDto> {
  const row = await getChangeSetRow(username, changeSetId)
  assertRevision(row, expectedRevision)

  if (row.status === 'applied') {
    return toChangeSetDto(row)
  }
  if (row.status !== 'ready_to_apply') {
    throw AppError.badRequest(
      `Change set cannot be applied from status ${row.status}`,
      'change_set.invalid_status'
    )
  }

  const project = await getProject(username, row.projectId)
  if (!project) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }

  const dataDir = getAppContext().dataDir
  const patchText = readStoredPatch(dataDir, changeSetId)
  if (patchText == null) {
    throw AppError.badRequest('Change set patch artifact missing', 'change_set.patch_missing')
  }

  const lease = acquireWorkspaceLease({
    workspacePath: project.workspaceRoot,
    ownerKind: 'change_set',
    ownerId: changeSetId
  })
  if (!lease) {
    throw AppError.conflict('Workspace is busy; cannot apply change set', {
      code: 'change_set.workspace_busy'
    })
  }

  const applyingRow = await getChangeSetRow(username, changeSetId)
  await updateChangeSet(applyingRow, { status: 'applying', lastErrorJson: null })

  try {
    const result = applyPatchToMainWorkspace({
      workspaceRoot: project.workspaceRoot,
      baseCommit: row.baseCommit,
      patchText
    })

    const current = await getChangeSetRow(username, changeSetId)

    if (result.kind === 'applied') {
      removeChangeSetWorktree(dataDir, changeSetId, project.workspaceRoot)
      return updateChangeSet(current, {
        status: 'applied',
        worktreePath: null,
        appliedAt: nowSec(),
        lastErrorJson: null,
        validationJson: JSON.stringify({ applied: true })
      })
    }

    return updateChangeSet(current, {
      status: 'needs_resolution',
      validationJson: JSON.stringify({ reason: result.reason }),
      lastErrorJson: JSON.stringify({
        code: `change_set.${result.reason}`,
        message:
          result.reason === 'base_changed'
            ? 'Main workspace HEAD changed since Change Set was created'
            : result.reason === 'apply_conflict'
              ? 'Patch does not apply cleanly to the main workspace'
              : result.reason === 'empty_patch'
                ? 'Patch is empty'
                : 'Unable to apply change set to this workspace'
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const current = await getChangeSetRow(username, changeSetId)
    return updateChangeSet(current, {
      status: 'failed',
      lastErrorJson: JSON.stringify({ code: 'change_set.apply_failed', message })
    })
  } finally {
    releaseWorkspaceLease(lease.leaseId)
  }
}

/**
 * Rebase a Change Set onto the current main workspace base (P6 wrap-up).
 * Git: recreate worktree at HEAD and re-apply patch.
 * Non-git: refresh COW mirrors from current workspace (edits reset).
 */
export async function rebaseChangeSet(
  username: string,
  changeSetId: string,
  expectedRevision?: number
): Promise<ChangeSetDto> {
  const row = await getChangeSetRow(username, changeSetId)
  assertRevision(row, expectedRevision)

  if (row.status === 'applying' || row.status === 'applied' || row.status === 'cancelled') {
    throw AppError.badRequest(
      `Change set cannot be rebased from status ${row.status}`,
      'change_set.invalid_status'
    )
  }

  const project = await getProject(username, row.projectId)
  if (!project) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }

  const dataDir = getAppContext().dataDir
  const patchText = readStoredPatch(dataDir, changeSetId) ?? ''

  if (isGitWorkspace(project.workspaceRoot)) {
    const rebased = rebaseGitWorktree({
      dataDir,
      changeSetId,
      workspaceRoot: project.workspaceRoot,
      patchText
    })

    if (rebased.patchApplied) {
      return updateChangeSet(row, {
        status: 'editing',
        worktreePath: rebased.worktreePath,
        baseCommit: rebased.baseCommit,
        baseWorkspaceGeneration: rebased.baseCommit,
        patchHash: null,
        patchArtifactId: null,
        validationJson: JSON.stringify({ rebased: true, patchApplied: true }),
        lastErrorJson: null
      })
    }

    return updateChangeSet(row, {
      status: 'needs_resolution',
      worktreePath: rebased.worktreePath,
      baseCommit: rebased.baseCommit,
      baseWorkspaceGeneration: rebased.baseCommit,
      validationJson: JSON.stringify({ rebased: true, patchApplied: false }),
      lastErrorJson: JSON.stringify({
        code: 'change_set.rebase_conflict',
        message: 'Patch does not apply cleanly onto the new base; resolve in the worktree'
      })
    })
  }

  removeChangeSetWorktree(dataDir, changeSetId, project.workspaceRoot)
  const prepared = prepareChangeSetWorktree({
    dataDir,
    changeSetId,
    workspaceRoot: project.workspaceRoot
  })
  return updateChangeSet(row, {
    status: 'editing',
    worktreePath: prepared.worktreePath,
    baseCommit: prepared.baseCommit,
    baseWorkspaceGeneration: prepared.baseCommit,
    patchHash: null,
    patchArtifactId: null,
    validationJson: JSON.stringify({ rebased: true, kind: 'non_git', editsReset: true }),
    lastErrorJson: null
  })
}

export async function cancelChangeSet(
  username: string,
  changeSetId: string,
  expectedRevision?: number
): Promise<ChangeSetDto> {
  const row = await getChangeSetRow(username, changeSetId)

  if (row.status === 'cancelled' || row.status === 'applied') {
    return toChangeSetDto(row)
  }

  assertRevision(row, expectedRevision)

  if (row.status === 'applying') {
    throw AppError.badRequest('Change set is applying; wait or retry later', 'change_set.busy')
  }

  const project = await getProject(username, row.projectId)
  const dataDir = getAppContext().dataDir
  removeChangeSetWorktree(dataDir, changeSetId, project?.workspaceRoot)

  return updateChangeSet(row, {
    status: 'cancelled',
    worktreePath: null
  })
}

export async function listProjectChangeSets(
  username: string,
  projectId: string
): Promise<ChangeSetDto[]> {
  const project = await getProject(username, projectId)
  if (!project) {
    throw AppError.notFound('Project not found', 'project.not_found')
  }
  const db = getDb()
  const rows = await db
    .select()
    .from(changeSets)
    .where(and(eq(changeSets.projectId, projectId), eq(changeSets.username, username)))
  return rows.map(toChangeSetDto)
}
