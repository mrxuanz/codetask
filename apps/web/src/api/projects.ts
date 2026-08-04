import { api } from './client'
import type { ApiSuccess } from './types'

export interface Project {
  id: string
  actorId: string
  title: string
  workspaceRoot: string
  createdAt: number
  updatedAt: number
}

export interface CreateProjectInput {
  workspaceRoot: string
  title?: string
  createIfMissing?: boolean
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

export function fetchProjects(): Promise<ApiSuccess<Project[]>> {
  return api<Project[]>('/api/projects')
}

export function createProject(input: CreateProjectInput): Promise<ApiSuccess<Project>> {
  return api<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      title: input.title,
      createIfMissing: input.createIfMissing ?? true
    })
  })
}

export function deleteProject(projectId: string): Promise<ApiSuccess<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/projects/${projectId}`, { method: 'DELETE' })
}

export function fetchProjectWorkspaceAccess(
  projectId: string
): Promise<ApiSuccess<ProjectWorkspaceAccess>> {
  return api<ProjectWorkspaceAccess>(`/api/projects/${projectId}/workspace-access`)
}
