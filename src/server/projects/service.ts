import { randomUUID } from 'crypto'
import { and, desc, eq } from 'drizzle-orm'
import type Database from 'better-sqlite3'
import { AppError } from '../error'
import { getDb, type AppDatabase } from '../db'
import { conversationTurns, projects, type Project } from '../db/schema'
import { findWorkspaceLeaseConflictSnapshot } from '../infra/workspace-lease-store'
import { cleanDisplayPath, inferTitleFromPath, normalizeWorkspacePath } from '../fs'

function getSqliteClient(db: AppDatabase): Database.Database | null {
  return (db as AppDatabase & { $client?: Database.Database }).$client ?? null
}

function readExecutionJobConflict(
  ownerId: string,
  projectId: string,
  actorId: string
): { title: string; state: string } | null {
  const client = getSqliteClient(getDb())
  if (!client) return null
  try {
    const row = client
      .prepare(
        `SELECT title, state FROM jobs WHERE id = ? AND project_id = ? AND actor_id = ? LIMIT 1`
      )
      .get(ownerId, projectId, actorId) as { title: string; state: string } | undefined
    return row ?? null
  } catch {
    return null
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function sanitizeProject(row: Project): Project {
  return {
    ...row,
    workspaceRoot: cleanDisplayPath(row.workspaceRoot)
  }
}

function pathsEqual(left: string, right: string): boolean {
  return cleanDisplayPath(left).toLowerCase() === cleanDisplayPath(right).toLowerCase()
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

export async function listProjects(actorId: string): Promise<Project[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.actorId, actorId))
    .orderBy(desc(projects.updatedAt), projects.title)

  return rows.map(sanitizeProject)
}

export async function findProjectByWorkspaceRoot(
  actorId: string,
  workspaceRootInput: string,
  createIfMissing = false
): Promise<Project | null> {
  const workspaceRoot = normalizeWorkspacePath(workspaceRootInput, createIfMissing)
  const db = getDb()

  const exact = await db
    .select()
    .from(projects)
    .where(and(eq(projects.actorId, actorId), eq(projects.workspaceRoot, workspaceRoot)))
    .limit(1)

  if (exact[0]) return sanitizeProject(exact[0])

  const rows = await listProjects(actorId)
  return rows.find((row) => pathsEqual(row.workspaceRoot, workspaceRoot)) ?? null
}

export async function createProject(
  actorId: string,
  workspaceRootInput: string,
  title?: string,
  createIfMissing = true
): Promise<Project> {
  const workspaceRoot = normalizeWorkspacePath(workspaceRootInput, createIfMissing)
  const existing = await findProjectByWorkspaceRoot(actorId, workspaceRoot, createIfMissing)
  if (existing) return existing

  const resolvedTitle = title?.trim() || inferTitleFromPath(workspaceRoot)
  const id = randomUUID()
  const now = nowSec()
  const db = getDb()

  try {
    await db.insert(projects).values({
      id,
      actorId,
      title: resolvedTitle,
      workspaceRoot,
      createdAt: now,
      updatedAt: now
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await findProjectByWorkspaceRoot(actorId, workspaceRoot, createIfMissing)
      if (raced) return raced
    }
    throw error
  }

  const row = await getProject(actorId, id)
  if (!row) {
    throw AppError.internal('Failed to read project after creation', 'turn.unknown')
  }
  return row
}

export async function getProject(actorId: string, projectId: string): Promise<Project | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.actorId, actorId), eq(projects.id, projectId)))
    .limit(1)

  const row = rows[0]
  return row ? sanitizeProject(row) : null
}

export interface ProjectWorkspaceAccess {
  mode: 'read_write' | 'read_only'
  blocker:
    | {
        kind: 'task'
        taskId: string
        taskTitle: string
        status: string
      }
    | {
        kind: 'conversation'
        turnId: string
        threadId: string | null
      }
    | null
}

/** Read-only UI snapshot. The lease acquisition path remains the concurrency authority. */
export async function getProjectWorkspaceAccess(
  actorId: string,
  projectId: string
): Promise<ProjectWorkspaceAccess> {
  const project = await getProject(actorId, projectId)
  if (!project) throw AppError.notFound('Project not found', 'project.not_found')

  const conflict = findWorkspaceLeaseConflictSnapshot(project.workspaceRoot)
  if (!conflict) {
    return { mode: 'read_write', blocker: null }
  }
  if (conflict.ownerKind === 'conversation') {
    const turn = getDb()
      .select({ conversationId: conversationTurns.conversationId })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, conflict.ownerId))
      .limit(1)
      .all()[0]
    return {
      mode: 'read_only',
      blocker: {
        kind: 'conversation',
        turnId: conflict.ownerId,
        // API field remains threadId; value is conversation_threads.id.
        threadId: turn?.conversationId ?? null
      }
    }
  }

  // Execution leases use `job-run`; residual upgrade leases may still say `thread_job`.
  if (conflict.ownerKind !== 'job-run' && conflict.ownerKind !== 'thread_job') {
    return { mode: 'read_write', blocker: null }
  }

  const executionJob = readExecutionJobConflict(conflict.ownerId, projectId, actorId)
  if (executionJob) {
    return {
      mode: 'read_only',
      blocker: {
        kind: 'task',
        taskId: conflict.ownerId,
        taskTitle: executionJob.title ?? '正在执行的任务',
        status: executionJob.state ?? 'running'
      }
    }
  }

  return {
    mode: 'read_only',
    blocker: {
      kind: 'task',
      taskId: conflict.ownerId,
      taskTitle: '正在执行的任务',
      status: 'running'
    }
  }
}

export async function touchProject(actorId: string, projectId: string): Promise<void> {
  const db = getDb()
  await db
    .update(projects)
    .set({ updatedAt: nowSec() })
    .where(and(eq(projects.actorId, actorId), eq(projects.id, projectId)))
}

export async function deleteProject(actorId: string, projectId: string): Promise<void> {
  const { drainAndDeleteProject } = await import('../infra/deletion-coordinator')
  await drainAndDeleteProject(actorId, projectId)
}
