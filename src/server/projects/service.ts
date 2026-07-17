import { randomUUID } from 'crypto'
import { and, desc, eq } from 'drizzle-orm'
import { AppError } from '../error'
import { getDb } from '../db'
import { projects, threadJobs, type Project } from '../db/schema'
import { controlJobs } from '../infra/sqlite/control-plane/schema'
import { findWorkspaceLeaseConflictSnapshot } from '../legacy-control-plane/workspace-lease-store'
import { cleanDisplayPath, inferTitleFromPath, normalizeWorkspacePath } from '../fs'

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

export async function listProjects(username: string): Promise<Project[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.username, username))
    .orderBy(desc(projects.updatedAt), projects.title)

  return rows.map(sanitizeProject)
}

export async function findProjectByWorkspaceRoot(
  username: string,
  workspaceRootInput: string,
  createIfMissing = false
): Promise<Project | null> {
  const workspaceRoot = normalizeWorkspacePath(workspaceRootInput, createIfMissing)
  const db = getDb()

  const exact = await db
    .select()
    .from(projects)
    .where(and(eq(projects.username, username), eq(projects.workspaceRoot, workspaceRoot)))
    .limit(1)

  if (exact[0]) return sanitizeProject(exact[0])

  const rows = await listProjects(username)
  return rows.find((row) => pathsEqual(row.workspaceRoot, workspaceRoot)) ?? null
}

export async function createProject(
  username: string,
  workspaceRootInput: string,
  title?: string,
  createIfMissing = true
): Promise<Project> {
  const workspaceRoot = normalizeWorkspacePath(workspaceRootInput, createIfMissing)
  const existing = await findProjectByWorkspaceRoot(username, workspaceRoot, createIfMissing)
  if (existing) return existing

  const resolvedTitle = title?.trim() || inferTitleFromPath(workspaceRoot)
  const id = randomUUID()
  const now = nowSec()
  const db = getDb()

  try {
    await db.insert(projects).values({
      id,
      username,
      title: resolvedTitle,
      workspaceRoot,
      createdAt: now,
      updatedAt: now
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await findProjectByWorkspaceRoot(username, workspaceRoot, createIfMissing)
      if (raced) return raced
    }
    throw error
  }

  const row = await getProject(username, id)
  if (!row) {
    throw AppError.internal('Failed to read project after creation', 'turn.unknown')
  }
  return row
}

export async function getProject(username: string, projectId: string): Promise<Project | null> {
  const db = getDb()
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.username, username), eq(projects.id, projectId)))
    .limit(1)

  const row = rows[0]
  return row ? sanitizeProject(row) : null
}

export interface ProjectWorkspaceAccess {
  mode: 'read_write' | 'read_only'
  blocker: {
    kind: 'task'
    taskId: string
    taskTitle: string
    status: string
  } | null
}

/** Read-only UI snapshot. The lease acquisition path remains the concurrency authority. */
export async function getProjectWorkspaceAccess(
  username: string,
  projectId: string
): Promise<ProjectWorkspaceAccess> {
  const project = await getProject(username, projectId)
  if (!project) throw AppError.notFound('Project not found', 'project.not_found')

  const conflict = findWorkspaceLeaseConflictSnapshot(project.workspaceRoot)
  if (!conflict || conflict.ownerKind !== 'thread_job') {
    return { mode: 'read_write', blocker: null }
  }

  const legacyJob = getDb()
    .select({ title: threadJobs.title, status: threadJobs.status })
    .from(threadJobs)
    .where(and(eq(threadJobs.id, conflict.ownerId), eq(threadJobs.username, username)))
    .limit(1)
    .all()[0]
  if (legacyJob) {
    return {
      mode: 'read_only',
      blocker: {
        kind: 'task',
        taskId: conflict.ownerId,
        taskTitle: legacyJob.title,
        status: legacyJob.status
      }
    }
  }

  const controlJob = getDb()
    .select({ title: controlJobs.title, state: controlJobs.state })
    .from(controlJobs)
    .where(and(eq(controlJobs.id, conflict.ownerId), eq(controlJobs.projectId, projectId)))
    .limit(1)
    .all()[0]

  return {
    mode: 'read_only',
    blocker: {
      kind: 'task',
      taskId: conflict.ownerId,
      taskTitle: controlJob?.title ?? '正在执行的任务',
      status: controlJob?.state ?? 'running'
    }
  }
}

export async function touchProject(username: string, projectId: string): Promise<void> {
  const db = getDb()
  await db
    .update(projects)
    .set({ updatedAt: nowSec() })
    .where(and(eq(projects.username, username), eq(projects.id, projectId)))
}

export async function deleteProject(username: string, projectId: string): Promise<void> {
  const { drainAndDeleteProject } = await import('../legacy-control-plane/deletion-coordinator')
  await drainAndDeleteProject(username, projectId)
}
