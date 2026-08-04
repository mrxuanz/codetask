import { isAbsolute, resolve } from 'node:path'

export type ServiceBootstrapCli = {
  host: string
  /** 0 = OS ephemeral bind; parent reads actual port from ready handshake. */
  port: number
  smokeTest: boolean
  dataDir?: string
  readyFd?: number
  bootstrapTokenFd?: number
  runManifest?: string
  rendererDevUrl?: string
  /** Headless recovery only: path to installation master key file. */
  masterKeyFile?: string
}

const DEFAULT_SERVER_PORT = 8080

function readArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

function readOptionalFd(argv: string[], flag: string): number | undefined {
  const raw = readArgValue(argv, flag)
  if (!raw) return undefined
  const fd = Number.parseInt(raw, 10)
  if (!Number.isInteger(fd) || fd < 0) {
    throw new Error(`Invalid ${flag}: ${raw}`)
  }
  return fd
}

function readPort(argv: string[], fallback: number): number {
  const raw = readArgValue(argv, '--port')
  if (!raw) return fallback
  const port = Number.parseInt(raw, 10)
  // Allow 0 for OS-assigned ephemeral port (Batch C ready handshake).
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`)
  }
  return port
}

function readAbsolutePath(argv: string[], flag: string): string | undefined {
  const raw = readArgValue(argv, flag)
  if (!raw) return undefined
  const absolute = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  return absolute
}

/**
 * Parse Node Service / standalone bootstrap argv.
 * Product configuration comes from CLI flags — not CODETASK_* environment variables.
 */
export function parseServiceBootstrapArgs(argv: string[] = process.argv): ServiceBootstrapCli {
  const smokeTest = argv.includes('--smoke-test')
  const host = readArgValue(argv, '--host') ?? (argv.includes('--host') ? '0.0.0.0' : '127.0.0.1')
  return {
    host,
    port: readPort(argv, DEFAULT_SERVER_PORT),
    smokeTest,
    dataDir: readAbsolutePath(argv, '--data-dir'),
    readyFd: readOptionalFd(argv, '--ready-fd'),
    bootstrapTokenFd: readOptionalFd(argv, '--bootstrap-token-fd'),
    runManifest: readAbsolutePath(argv, '--run-manifest'),
    rendererDevUrl: readArgValue(argv, '--renderer-dev-url'),
    masterKeyFile: readAbsolutePath(argv, '--master-key-file')
  }
}
