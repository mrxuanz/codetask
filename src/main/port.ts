import { createServer } from 'net'

const MAX_PORT_ATTEMPTS = 100

function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()

    tester.once('error', () => resolve(false))
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })

    tester.listen(port, host)
  })
}

export async function resolveAvailablePort(
  host: string,
  requestedPort: number,
  maxAttempts = MAX_PORT_ATTEMPTS
): Promise<{ port: number; changed: boolean }> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = requestedPort + offset
    if (port > 65535) break

    if (await isPortAvailable(host, port)) {
      return { port, changed: offset > 0 }
    }
  }

  throw new Error(
    `No available port found starting from ${requestedPort} on ${host} after ${maxAttempts} attempts`
  )
}
