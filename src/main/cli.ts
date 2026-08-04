import { parseServiceBootstrapArgs } from '@codetask/service-bootstrap'

export type AppMode = 'desktop' | 'server'

export interface CliOptions {
  mode: AppMode
  host: string
  /** 0 = OS ephemeral bind (server/service hosts). */
  port: number
  smokeTest: boolean
  /** Absolute data directory from --data-dir (service/standalone). */
  dataDir?: string
  /** Write ready JSON then close (Electron/parent supervision). */
  readyFd?: number
  bootstrapTokenFd?: number
  runManifest?: string
  rendererDevUrl?: string
  masterKeyFile?: string
}

const DEFAULT_DESKTOP_PORT = 3000
const DEFAULT_SERVER_PORT = 8080

function readArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

function readPort(argv: string[], fallback: number, allowEphemeral: boolean): number {
  const raw = readArgValue(argv, '--port')
  if (!raw) return fallback

  const port = Number.parseInt(raw, 10)
  const min = allowEphemeral ? 0 : 1
  if (!Number.isInteger(port) || port < min || port > 65535) {
    throw new Error(`Invalid port: ${raw}`)
  }

  return port
}

export function parseCliArgs(argv: string[] = process.argv): CliOptions {
  const smokeTest = argv.includes('--smoke-test')
  const serve = argv.includes('--serve') || smokeTest
  if (serve) {
    const bootstrap = parseServiceBootstrapArgs(argv)
    return {
      mode: 'server',
      host: bootstrap.host,
      port: bootstrap.port,
      smokeTest: bootstrap.smokeTest || smokeTest,
      dataDir: bootstrap.dataDir,
      readyFd: bootstrap.readyFd,
      bootstrapTokenFd: bootstrap.bootstrapTokenFd,
      runManifest: bootstrap.runManifest,
      rendererDevUrl: bootstrap.rendererDevUrl,
      masterKeyFile: bootstrap.masterKeyFile
    }
  }

  const port = readPort(argv, DEFAULT_DESKTOP_PORT, false)
  return {
    mode: 'desktop',
    host: '127.0.0.1',
    port,
    smokeTest
  }
}

/** Parse the dedicated Node entry point, which is always a server even without `--serve`. */
export function parseServerCliArgs(argv: string[] = process.argv): CliOptions {
  const normalized = argv.includes('--serve') ? argv : [...argv, '--serve']
  const parsed = parseCliArgs(normalized)
  // Dedicated server entry defaults remain 8080 when --port omitted.
  if (!readArgValue(normalized, '--port') && parsed.port === DEFAULT_SERVER_PORT) {
    return parsed
  }
  return parsed
}
