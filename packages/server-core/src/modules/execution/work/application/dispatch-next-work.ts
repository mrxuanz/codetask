import type { ExecuteWorkService } from './execute-work.ts'

export function createDispatchNextWorkService(deps: { executeWork: ExecuteWorkService }) {
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
