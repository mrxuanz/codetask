import type { SafeLogger } from './ports/safe-logger'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly meta?: Record<string, unknown> | undefined
  readonly timestamp: number
}

interface SafeLoggerConfig {
  readonly logDir?: string
  readonly maxBufferSize?: number
  readonly rateLimitWindowMs?: number
  readonly rateLimitMaxPerWindow?: number
}

export class SafeLoggerImpl implements SafeLogger {
  private readonly buffer: LogEntry[] = []
  private readonly maxBufferSize: number
  private consoleDisabled = false
  private fileSinkDisabled = false
  private readonly logFilePath: string | null

  private readonly rateLimitCounts = new Map<string, { count: number; windowStart: number }>()
  private readonly rateLimitWindowMs: number
  private readonly rateLimitMaxPerWindow: number

  constructor(config?: SafeLoggerConfig) {
    this.maxBufferSize = config?.maxBufferSize ?? 1000
    this.rateLimitWindowMs = config?.rateLimitWindowMs ?? 60_000
    this.rateLimitMaxPerWindow = config?.rateLimitMaxPerWindow ?? 100

    if (config?.logDir) {
      try {
        mkdirSync(config.logDir, { recursive: true })
        this.logFilePath = join(config.logDir, `app-${process.pid}.log`)
      } catch {
        this.fileSinkDisabled = true
        this.logFilePath = null
      }
    } else {
      this.logFilePath = null
    }

    this.installStreamErrorHandlers()
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta)
  }

  getBuffer(): readonly LogEntry[] {
    return [...this.buffer]
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      meta,
      timestamp: Date.now()
    }

    // Add to ring buffer
    this.buffer.push(entry)
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift()
    }

    // Rate limiting check
    if (this.isRateLimited(message)) return

    // File sink (primary)
    if (!this.fileSinkDisabled && this.logFilePath) {
      this.writeToFile(entry)
    }

    // Console sink (best-effort)
    if (!this.consoleDisabled) {
      this.writeToConsole(level, message, meta)
    }
  }

  private writeToConsole(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    try {
      const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      if (meta) {
        logFn(`[${level.toUpperCase()}] ${message}`, meta)
      } else {
        logFn(`[${level.toUpperCase()}] ${message}`)
      }
    } catch {
      // Disable console transport on EIO/EPIPE
      this.consoleDisabled = true
    }
  }

  private writeToFile(entry: LogEntry): void {
    try {
      const line = JSON.stringify({
        ts: entry.timestamp,
        level: entry.level,
        msg: entry.message,
        ...entry.meta
      }) + '\n'
      appendFileSync(this.logFilePath!, line)
    } catch {
      // Disable file sink on failure - do not throw
      this.fileSinkDisabled = true
    }
  }

  private isRateLimited(message: string): boolean {
    const key = message.slice(0, 128)
    const now = Date.now()
    const entry = this.rateLimitCounts.get(key)

    if (!entry || now - entry.windowStart > this.rateLimitWindowMs) {
      this.rateLimitCounts.set(key, { count: 1, windowStart: now })
      return false
    }

    entry.count++
    if (entry.count > this.rateLimitMaxPerWindow) {
      return true
    }
    return false
  }

  private installStreamErrorHandlers(): void {
    const handleStreamError = (stream: NodeJS.WriteStream, name: string) => {
      stream.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EIO' || error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
          if (name === 'stdout') {
            // stdout EIO - disable console transport
            this.consoleDisabled = true
          } else {
            // stderr EIO - disable console error transport
            this.consoleDisabled = true
          }
          // Log to file if available (avoid recursion)
          if (!this.fileSinkDisabled && this.logFilePath) {
            try {
              const line = JSON.stringify({
                ts: Date.now(),
                level: 'warn',
                msg: `${name} stream error disabled`,
                code: error.code
              }) + '\n'
              appendFileSync(this.logFilePath, line)
            } catch {
              // Silently ignore
            }
          }
        }
        // Non-EIO errors: still disable transport to avoid recursion
        this.consoleDisabled = true
      })
    }

    if (process.stdout) handleStreamError(process.stdout as NodeJS.WriteStream, 'stdout')
    if (process.stderr) handleStreamError(process.stderr as NodeJS.WriteStream, 'stderr')
  }
}
