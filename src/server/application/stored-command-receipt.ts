export type JobCommandName =
  | 'request_pause'
  | 'continue_job'
  | 'cancel_job'
  | 'restart_execution'

export interface StoredCommandReceipt {
  readonly schemaVersion: 1
  readonly command: JobCommandName
  readonly jobId: string
  readonly revision: number
  readonly mustPause?: boolean
  readonly response: unknown
}

export function wrapCommandReceipt(input: {
  readonly command: JobCommandName
  readonly jobId: string
  readonly revision: number
  readonly mustPause?: boolean
  readonly response: unknown
}): StoredCommandReceipt {
  return {
    schemaVersion: 1,
    command: input.command,
    jobId: input.jobId,
    revision: input.revision,
    ...(input.mustPause === undefined ? {} : { mustPause: input.mustPause }),
    response: input.response
  }
}

export function parseStoredCommandReceipt(responseJson: string): StoredCommandReceipt {
  const parsed = JSON.parse(responseJson) as Partial<StoredCommandReceipt>
  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.command !== 'string' ||
    typeof parsed.jobId !== 'string' ||
    typeof parsed.revision !== 'number' ||
    !('response' in parsed)
  ) {
    throw new Error('command.receipt_invalid')
  }
  return parsed as StoredCommandReceipt
}
