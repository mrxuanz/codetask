import { TIMEOUTS } from '../config/timeouts'
import type { OperationLedger } from '../reports/ledger'

export type ApiEnvelope<T = unknown> = {
  success?: boolean
  data?: T
  message?: string
  status?: number
  error?: string
}

export class PublicApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly options: {
      token?: string | (() => string | undefined)
      ledger?: OperationLedger
      caseRunId?: string
      timeoutMs?: number
    } = {}
  ) {}

  withToken(token: string | (() => string | undefined)): PublicApiClient {
    return new PublicApiClient(this.baseUrl, { ...this.options, token })
  }

  withCase(caseRunId: string): PublicApiClient {
    return new PublicApiClient(this.baseUrl, { ...this.options, caseRunId })
  }

  private resolveToken(): string | undefined {
    const token = this.options.token
    return typeof token === 'function' ? token() : token
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    meta?: { operationId?: string; auth?: boolean }
  ): Promise<{ status: number; data: T; raw: ApiEnvelope<T> }> {
    const headers: Record<string, string> = {
      Accept: 'application/json'
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (meta?.auth !== false) {
      const token = this.resolveToken()
      if (token) headers.Authorization = `Bearer ${token}`
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? TIMEOUTS.httpRequestMs
    )
    let status = 0
    let raw: ApiEnvelope<T> = {}
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      })
      status = response.status
      raw = (await response.json().catch(() => ({}))) as ApiEnvelope<T>
      this.options.ledger?.record({
        caseRunId: this.options.caseRunId,
        operationId: meta?.operationId ?? `http.${method}.${path}`,
        transport: 'http',
        method,
        routeOrTool: path,
        status,
        ok: response.ok,
        detail: { success: raw.success, message: raw.message }
      })
      return { status, data: raw.data as T, raw }
    } catch (error) {
      this.options.ledger?.record({
        caseRunId: this.options.caseRunId,
        operationId: meta?.operationId ?? `http.${method}.${path}`,
        transport: 'http',
        method,
        routeOrTool: path,
        status: 'error',
        ok: false,
        detail: { error: String(error) }
      })
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async health(): Promise<boolean> {
    const result = await this.request<{ status?: string }>(
      'GET',
      '/api/health',
      undefined,
      { operationId: 'health.get', auth: false }
    )
    return result.status === 200 && result.data?.status === 'ok'
  }

  async bootstrap(auth = false): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>(
      'GET',
      '/api/bootstrap',
      undefined,
      { operationId: 'auth.bootstrap', auth }
    )
    return (result.data ?? {}) as Record<string, unknown>
  }

  async uploadMultipart<T = unknown>(
    path: string,
    form: FormData,
    meta?: { operationId?: string }
  ): Promise<{ status: number; data: T; raw: ApiEnvelope<T> }> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = this.resolveToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? TIMEOUTS.httpRequestMs
    )
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal
      })
      const raw = (await response.json().catch(() => ({}))) as ApiEnvelope<T>
      this.options.ledger?.record({
        caseRunId: this.options.caseRunId,
        operationId: meta?.operationId ?? `http.POST.${path}`,
        transport: 'http',
        method: 'POST',
        routeOrTool: path,
        status: response.status,
        ok: response.ok,
        detail: { success: raw.success, message: raw.message }
      })
      return { status: response.status, data: raw.data as T, raw }
    } finally {
      clearTimeout(timer)
    }
  }
}
