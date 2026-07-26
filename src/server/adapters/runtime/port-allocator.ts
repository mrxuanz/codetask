/**
 * Ephemeral port allocator for sandboxed local servers (e.g. OpenCode/ACP).
 * Must never bind reserved fixed host ports such as 5173 (重构.md §10.6).
 */

import { createServer } from 'node:net'

/** Host ports that sandbox instances must not bind or reclaim. */
export const RESERVED_FIXED_PORTS: ReadonlySet<number> = new Set([5173])

export class PortAllocationError extends Error {
  constructor(
    message: string,
    readonly code: 'runtime.port.reserved' | 'runtime.port.allocate_failed'
  ) {
    super(message)
    this.name = 'PortAllocationError'
  }
}

export function assertPortNotReserved(port: number): void {
  if (RESERVED_FIXED_PORTS.has(port)) {
    throw new PortAllocationError(
      `Refusing to bind reserved fixed port ${port}`,
      'runtime.port.reserved'
    )
  }
}

/**
 * Bind listen(0) on loopback, read the assigned port, then close.
 * Callers that need a held reservation should upgrade to a socket-hand-off later.
 */
export async function allocateEphemeralPort(
  host: string = '127.0.0.1'
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', (error) => {
      reject(
        new PortAllocationError(
          `Ephemeral port allocation failed: ${error.message}`,
          'runtime.port.allocate_failed'
        )
      )
    })
    server.listen(0, host, () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') {
          try {
            assertPortNotReserved(address.port)
            resolve(address.port)
          } catch (error) {
            reject(error)
          }
          return
        }
        reject(
          new PortAllocationError(
            'Ephemeral port allocation returned no address',
            'runtime.port.allocate_failed'
          )
        )
      })
    })
  })
}
