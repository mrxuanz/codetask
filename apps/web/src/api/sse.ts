import { ApiError } from './client'
import {
  handleUnauthorizedApiError,
  shouldClearSessionOnApiError
} from '@renderer/auth/sessionRedirect'

export async function throwIfNotSseResponse(res: Response): Promise<void> {
  const contentType = res.headers.get('Content-Type') ?? ''

  if (res.ok && contentType.includes('text/event-stream')) {
    return
  }

  const raw = await res.text()
  if (!raw.trim()) {
    throw new ApiError(
      res.ok ? 'SSE 响应无效' : `request failed with HTTP ${res.status}`,
      res.status,
      null
    )
  }

  try {
    const body = JSON.parse(raw) as {
      success?: boolean
      requestId?: string
      data?: unknown
      error?: { code?: string; message?: string; details?: Record<string, unknown> }
    }
    if (typeof body.success === 'boolean') {
      if (!res.ok || !body.success) {
        const message = body.error?.message || `request failed with HTTP ${res.status}`
        const code = body.error?.code || message
        if (shouldClearSessionOnApiError(res.status, res.status, message, body.error?.details)) {
          handleUnauthorizedApiError()
        }
        throw new ApiError(message, res.status, body.error?.details ?? body.error, code, {
          requestId: body.requestId,
          details: body.error?.details
        })
      }
      throw new ApiError(
        body.error?.message || 'SSE 响应无效',
        res.status,
        body.data,
        body.error?.code
      )
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
  }

  throw new ApiError(
    raw || (res.ok ? 'SSE 响应无效' : `request failed with HTTP ${res.status}`),
    res.status,
    { raw }
  )
}
