export interface ApiResponse<T> {
  data: T
  status: number
  extra: Record<string, unknown>
  message: string
  success: boolean
}
