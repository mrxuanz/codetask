/**
 * @deprecated Prefer ApiSuccess / ApiFailure from `./api.ts`.
 * Legacy hybrid envelope; production client no longer uses this shape (Batch R4).
 */
export type ClientApiResponse<T> = {
  data: T
  status: number
  extra: Record<string, unknown>
  message: string
  success: boolean
}
