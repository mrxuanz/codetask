import { randomUUID } from 'crypto'
import { and, desc, eq } from 'drizzle-orm'
import { AppError } from '../error'
import { getDb } from '../db'
import { projects, type Project } from '../db/schema'
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
