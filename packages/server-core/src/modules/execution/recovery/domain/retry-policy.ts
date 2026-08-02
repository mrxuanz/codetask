export const MAX_INFRA_RETRIES = 3
export const INFRA_BACKOFF_MS = 1_000

export function shouldRetryInfra(attemptCount: number): boolean {
  return attemptCount < MAX_INFRA_RETRIES
}
