import type { ExecuteWorkService } from './execute-work.ts'

export type DispatchNextWorkService = {
  dispatch(input: {
    jobId: string
    workId: string
    runId: string
    workspaceRoot: string
  }): Promise<void>
}

export function createDispatchNextWorkService(deps: {
  executeWork: ExecuteWorkService
}): DispatchNextWorkService {
  return {
    async dispatch(input: {
      jobId: string
      workId: string
      runId: string
      workspaceRoot: string
    }): Promise<void> {
      await deps.executeWork.dispatch(input)
    }
  }
}
