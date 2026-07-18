/**
 * OpenCode HTTP transport helpers for Node.
 *
 * OpenCode SDK sets `req.timeout = false` on its fetch wrapper, but that only
 * disables timeouts on Bun. Node's undici defaults headersTimeout/bodyTimeout
 * to 300s, so long `session.prompt` waits die around five minutes with
 * TypeError "fetch failed" while the OpenCode server keeps running.
 */

import { createRequire } from 'module'

const nodeRequire = createRequire(import.meta.url)

/** Transient transport failures that should retry / not look like logic errors. */
export function isTransientOpencodeTransportDetail(detail: string): boolean {
  const lower = detail.toLowerCase()
  return (
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('etimedout') ||
    lower.includes('ehostunreach') ||
    lower.includes('enotfound') ||
    lower.includes('socket hang up') ||
    lower.includes('network') ||
    lower.includes('und_err_') ||
    lower.includes('headers timeout') ||
    lower.includes('body timeout') ||
    lower.includes('other side closed') ||
    // Mis-wired custom fetch (seen when undici fetch rejected global Request)
    lower.includes('failed to parse url from')
  )
}

/**
 * Fetch wrapper with undici body/headers timeouts disabled so planner and
 * task turns can exceed the default 300s HTTP wait.
 *
 * Important: use globalThis.fetch with an Agent dispatcher — do NOT call
 * `require('undici').fetch(Request)`. npm undici and Node's built-in Request
 * can be different realms; that path throws
 * `Failed to parse URL from [object Request]`.
 */
export function createOpencodeLongTurnFetch(): {
  fetch: typeof globalThis.fetch
  close(): void
} {
  const { Agent } = nodeRequire('undici') as {
    Agent: new (options?: {
      headersTimeout?: number
      bodyTimeout?: number
      connect?: { timeout?: number }
    }) => { close(): Promise<void> | void }
  }
  const agent = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: 60_000 }
  })

  const fetchWithAgent: typeof globalThis.fetch = ((input, init) => {
    return globalThis.fetch(input, {
      ...(init ?? {}),
      // Node undici extension — disables the default 300s body/headers timers.
      dispatcher: agent
    } as RequestInit)
  }) as typeof globalThis.fetch

  return {
    fetch: fetchWithAgent,
    close() {
      try {
        void agent.close()
      } catch {
        // best-effort
      }
    }
  }
}
