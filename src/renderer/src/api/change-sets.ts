import type { ChangeSetDto } from '@shared/contracts/change-sets'
import { api } from './client'
import type { ApiResponse } from './types'

export function fetchProjectChangeSets(projectId: string): Promise<ApiResponse<ChangeSetDto[]>> {
  return api<ChangeSetDto[]>(`/api/projects/${projectId}/change-sets`)
}

export function fetchChangeSet(changeSetId: string): Promise<ApiResponse<ChangeSetDto>> {
  return api<ChangeSetDto>(`/api/change-sets/${changeSetId}`)
}

function command(
  changeSetId: string,
  action: 'ready' | 'apply' | 'rebase' | 'cancel',
  expectedRevision: number
): Promise<ApiResponse<ChangeSetDto>> {
  return api<ChangeSetDto>(`/api/change-sets/${changeSetId}/${action}`, {
    method: 'POST',
    body: JSON.stringify({ expectedRevision })
  })
}

export const applyChangeSet = (
  changeSetId: string,
  expectedRevision: number
): Promise<ApiResponse<ChangeSetDto>> => command(changeSetId, 'apply', expectedRevision)

export const markChangeSetReady = (
  changeSetId: string,
  expectedRevision: number
): Promise<ApiResponse<ChangeSetDto>> => command(changeSetId, 'ready', expectedRevision)

export const rebaseChangeSet = (
  changeSetId: string,
  expectedRevision: number
): Promise<ApiResponse<ChangeSetDto>> => command(changeSetId, 'rebase', expectedRevision)

export const cancelChangeSet = (
  changeSetId: string,
  expectedRevision: number
): Promise<ApiResponse<ChangeSetDto>> => command(changeSetId, 'cancel', expectedRevision)
