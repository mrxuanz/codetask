export type AppMode = 'desktop' | 'server'

export interface CliOptions {
  mode: AppMode
  host: string
  port: number
  smokeTest: boolean
  dataDir?: string
  bootstrapRoot?: string
  authSecretFile?: string
  staticDir?: string
  appRoot?: string
  rendererDevUrl?: string
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

function readNonEmptyOption(argv: string[], flag: string, label: string): string | undefined {
  const raw = readArgValue(argv, flag)
  const value = raw?.trim()
  if (argv.includes(flag) && (!value || value.startsWith('--'))) {
    throw new Error(`Invalid ${label}: expected a value after ${flag}`)
  }
  return value
}

export function parseCliArgs(argv: string[] = process.argv): CliOptions {
  const smokeTest = argv.includes('--smoke-test')
  const serve = argv.includes('--serve') || smokeTest
  const dataDir = readNonEmptyOption(argv, '--data-dir', 'data directory')
  const bootstrapRoot = readNonEmptyOption(argv, '--bootstrap-root', 'bootstrap root')
  const authSecretFile = readNonEmptyOption(argv, '--auth-secret-file', 'auth secret file')
  const staticDir = readNonEmptyOption(argv, '--static-dir', 'static directory')
  const appRoot = readNonEmptyOption(argv, '--app-root', 'application root')
  const rendererDevUrl = readNonEmptyOption(argv, '--renderer-dev-url', 'renderer development URL')
  const explicitOptions = {
    ...(dataDir ? { dataDir } : {}),
    ...(bootstrapRoot ? { bootstrapRoot } : {}),
    ...(authSecretFile ? { authSecretFile } : {}),
    ...(staticDir ? { staticDir } : {}),
    ...(appRoot ? { appRoot } : {}),
    ...(rendererDevUrl ? { rendererDevUrl } : {})
  }

  if (serve) {
    const host = readArgValue(argv, '--host') ?? (argv.includes('--host') ? '0.0.0.0' : '127.0.0.1')
    const port = readPort(argv, DEFAULT_SERVER_PORT)
    return { mode: 'server', host, port, smokeTest, ...explicitOptions }
  }

  const port = readPort(argv, DEFAULT_DESKTOP_PORT)
  return { mode: 'desktop', host: '127.0.0.1', port, smokeTest, ...explicitOptions }
}

/** Parse the dedicated Node entry point, which is always a server even without `--serve`. */
export function parseServerCliArgs(argv: string[] = process.argv): CliOptions {
  const normalized = argv.includes('--serve') ? argv : [...argv, '--serve']
  return parseCliArgs(normalized)
}
