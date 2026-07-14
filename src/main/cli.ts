export type AppMode = 'desktop' | 'server'

export interface CliOptions {
  mode: AppMode
  host: string
  port: number
  smokeTest: boolean
}

const DEFAULT_DESKTOP_PORT = 3000
const DEFAULT_SERVER_PORT = 8080

function readArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

function readPort(argv: string[], fallback: number): number {
  const raw = readArgValue(argv, '--port')
  if (!raw) return fallback

  const port = Number.parseInt(raw, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`)
  }

  return port
}

export function parseCliArgs(argv: string[] = process.argv): CliOptions {
  const smokeTest = argv.includes('--smoke-test')
  const serve = argv.includes('--serve') || smokeTest

  if (serve) {
    const host = readArgValue(argv, '--host') ?? (argv.includes('--host') ? '0.0.0.0' : '127.0.0.1')
    const port = readPort(argv, DEFAULT_SERVER_PORT)
    return { mode: 'server', host, port, smokeTest }
  }

  const port = readPort(argv, DEFAULT_DESKTOP_PORT)
  return { mode: 'desktop', host: '127.0.0.1', port, smokeTest }
}
