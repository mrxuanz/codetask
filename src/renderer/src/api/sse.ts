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
      message?: string
      status?: number
      success?: boolean
      data?: unknown
    }
    if (typeof body.success === 'boolean') {
      if (!res.ok || !body.success) {
        const apiStatus = typeof body.status === 'number' ? body.status : res.status
        const message = body.message || `request failed with HTTP ${res.status}`
        if (shouldClearSessionOnApiError(res.status, apiStatus, message, body.data)) {
          handleUnauthorizedApiError()
        }
        throw new ApiError(message, res.status, body.data, message)
      }
      throw new ApiError(body.message || 'SSE 响应无效', res.status, body.data, body.message)
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
