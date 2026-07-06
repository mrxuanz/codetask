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
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded && !isLoopbackAddress(forwarded)) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'MCP endpoints are localhost-only' }
      },
      403
    )
  }

  const remote = getConnInfo(c).remote
  const address = remote.address
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
