import { api } from './client'
import type { ApiResponse } from './types'

export interface Project {
  id: string
  username: string
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

export function fetchProjects(): Promise<ApiResponse<Project[]>> {
  return api<Project[]>('/api/projects')
}

export function createProject(input: CreateProjectInput): Promise<ApiResponse<Project>> {
  return api<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      title: input.title,
      createIfMissing: input.createIfMissing ?? true
    })
  })
}

export function deleteProject(projectId: string): Promise<ApiResponse<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(`/api/projects/${projectId}`, { method: 'DELETE' })
}
