export interface TaskExecutionRequest {
  readonly jobId: string
  readonly runId: string
  readonly fenceToken: string
  readonly executionGeneration: number
  readonly taskId: string
  readonly attemptId: string
  readonly title: string
  readonly abortSignal: AbortSignal
}

export type TaskExecutionOutcome =
  | { readonly kind: 'result'; readonly raw: unknown }
  | { readonly kind: 'waiting'; readonly externalOperationId: string }

export interface TaskExecutionProvider {
  executeTask(request: TaskExecutionRequest): Promise<TaskExecutionOutcome>
}
