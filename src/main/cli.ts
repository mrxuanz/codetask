export type AppMode = 'desktop' | 'server'

export interface CliOptions {
  mode: AppMode
  host: string
  port: number
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
  const serve = argv.includes('--serve')

  if (serve) {
    const host = readArgValue(argv, '--host') ?? '0.0.0.0'
    const port = readPort(argv, DEFAULT_SERVER_PORT)
    return { mode: 'server', host, port }
  }

  const port = readPort(argv, DEFAULT_DESKTOP_PORT)
  return { mode: 'desktop', host: '127.0.0.1', port }
}
