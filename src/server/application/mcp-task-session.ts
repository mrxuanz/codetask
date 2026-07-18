export interface TaskSessionContext {
  readonly jobId: string
  readonly taskId: string
  readonly attemptId: string
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
}

export interface McpTaskSession {
  readonly sessionContext: TaskSessionContext
  reportResult(rawInput: unknown): Promise<ReportTaskResultResponse>
}

export interface ReportTaskResultResponse {
  readonly success: boolean
  readonly revision?: number
  readonly error?: string
}

export function createMcpTaskSession(
  context: TaskSessionContext,
  reportFn: (session: TaskSessionContext, input: unknown) => Promise<ReportTaskResultResponse>
): McpTaskSession {
  return {
    sessionContext: context,
    async reportResult(rawInput: unknown): Promise<ReportTaskResultResponse> {
      // Agent cannot forge identity - it comes from trusted session context
      return reportFn(context, rawInput)
    }
  }
}
