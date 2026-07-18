import type { Context, Next } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized.startsWith('::ffff:127.0.0.1:')
  )
}

export async function requireLocalhost(c: Context, next: Next): Promise<Response | void> {
  // Do not trust x-forwarded-for — clients can spoof it. Only the real peer address counts.
  let address: string | undefined
  try {
    if (c.env) {
      address = getConnInfo(c).remote.address
    }
  } catch {
    address = undefined
  }
  if (!address || !isLoopbackAddress(address)) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'MCP endpoints are localhost-only' }
      },
      403
    )
  }

  await next()
}
