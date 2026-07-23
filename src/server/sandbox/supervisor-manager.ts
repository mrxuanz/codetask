import { EventEmitter } from 'events'
import { fork, type ChildProcess } from 'child_process'
import {
  isSupervisorCommand,
  isSupervisorEvent,
  type SupervisorCommand,
  type SupervisorEvent
} from '../../sandbox/supervisor-protocol'
import { processHostEnvironmentSource } from '../host-environment'
import { resolveMainSandboxScript } from './packaged-paths'
import { SandboxError } from './types'

const SUPERVISOR_START_TIMEOUT_MS = 30_000
const MAX_SUPERVISOR_RESTARTS = 5

function resolveSupervisorEntryPath(): string {
  const entry = resolveMainSandboxScript('supervisor-entry.js')
  if (entry) return entry
  throw new SandboxError(
    'Sandbox supervisor is not built; run npm run build first',
    'sandbox.supervisor.missing'
  )
}

export class SandboxSupervisorManager extends EventEmitter {
  private child: ChildProcess | null = null
  private ready = false
  private starting = false
  private shuttingDown = false
  private recycling = false
  private restartCount = 0
  private startPromise: Promise<void> | null = null
  private recyclePromise: Promise<void> | null = null
  private lastError: string | undefined

  statusSnapshot(): { ready: boolean; starting: boolean; lastError?: string | undefined } {
    return {
      ready: this.ready && Boolean(this.child && !this.child.killed),
      starting: this.starting,
      lastError: this.lastError
    }
  }

  async ensureReady(): Promise<void> {
    if (this.shuttingDown) {
      throw new SandboxError('sandbox supervisor is shutting down', 'sandbox.supervisor.shutdown')
    }
    if (this.recycling && this.recyclePromise) return this.recyclePromise
    if (this.ready && this.child && !this.child.killed) return
    if (this.startPromise) return this.startPromise

    this.startPromise = this.spawn()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.starting = true
      this.lastError = undefined
      const entry = resolveSupervisorEntryPath()
      const hostEnv = processHostEnvironmentSource.snapshot()
      const child = fork(entry, [], {
        execPath: process.execPath,
        env: {
          ...hostEnv,
          ELECTRON_RUN_AS_NODE: '1',
          CODETASK_SANDBOX_SUPERVISOR_WORKER: '1'
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      })

      this.child = child
      this.ready = false
      let settled = false

      const onReady = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.ready = true
        this.starting = false
        this.restartCount = 0
        this.lastError = undefined
        resolve()
      }

      const onFailed = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        this.starting = false
        this.lastError = error.message
        reject(error)
      }

      const timeout = setTimeout(() => {
        onFailed(new SandboxError('sandbox supervisor start timeout', 'sandbox.supervisor.timeout'))
      }, SUPERVISOR_START_TIMEOUT_MS)

      const onMessage = (message: unknown): void => {
        if (!isSupervisorEvent(message)) return
        this.emit('event', message)
        if (message.type === 'ready') {
          clearTimeout(timeout)
          onReady()
        }
      }

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const isCurrentChild = this.child === child
        const error = new SandboxError(
          `sandbox supervisor exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          'sandbox.supervisor.crashed'
        )
        if (!isCurrentChild) {
          // A force-recycled child may report exit after its replacement is
          // already ready. Never let that stale event clear or restart the
          // replacement supervisor.
          if (!settled) onFailed(error)
          return
        }

        const wasReady = this.ready
        this.ready = false
        this.starting = false
        this.child = null

        this.lastError = error.message

        this.emit('crash', error)

        if (!settled) {
          clearTimeout(timeout)
          onFailed(error)
          return
        }

        if (this.shuttingDown || this.recycling) return

        if (wasReady && this.restartCount < MAX_SUPERVISOR_RESTARTS) {
          this.restartCount += 1
          console.warn(
            `[sandbox] supervisor crashed, restarting (${this.restartCount}/${MAX_SUPERVISOR_RESTARTS})`
          )
          this.emit('restarting', { attempt: this.restartCount })
          void this.ensureReady().catch((restartError) => {
            console.error('[sandbox] supervisor restart failed:', restartError)
            this.emit('restart_failed', restartError)
          })
        }
      }

      const onStderr = (chunk: Buffer): void => {
        const text = chunk.toString('utf8').trim()
        if (text) {
          if (text.includes('[CODETASK_DEBUG:')) {
            console.error(text)
          } else {
            console.error(`[sandbox-supervisor] ${text}`)
          }
        }
      }

      const onStdout = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        if (text.includes('[CODETASK_DEBUG:')) {
          for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (trimmed.includes('[CODETASK_DEBUG:')) console.error(trimmed)
          }
        }
      }

      const cleanup = (): void => {
        clearTimeout(timeout)
        child.off('message', onMessage)
        child.off('exit', onExit)
        child.stderr?.off('data', onStderr)
        child.stdout?.off('data', onStdout)
      }

      child.on('message', onMessage)
      child.on('error', (error) => {
        clearTimeout(timeout)
        onFailed(error)
      })
      child.on('exit', (...args) => {
        cleanup()
        onExit(...args)
      })
      child.stderr?.on('data', onStderr)
      child.stdout?.on('data', onStdout)
    })
  }

  send(command: SupervisorCommand): void {
    if (!this.child?.connected) {
      throw new SandboxError('sandbox supervisor not connected', 'sandbox.supervisor.disconnected')
    }
    this.child.send(command)
  }

  async recycle(reason: string): Promise<void> {
    if (this.shuttingDown) {
      throw new SandboxError('sandbox supervisor is shutting down', 'sandbox.supervisor.shutdown')
    }
    if (this.recyclePromise) return this.recyclePromise

    this.recyclePromise = this.recycleOnce(reason)
    try {
      await this.recyclePromise
    } finally {
      this.recyclePromise = null
    }
  }

  private async recycleOnce(reason: string): Promise<void> {
    this.recycling = true
    try {
      this.lastError = reason
      // If recycle races the initial startup, let that attempt settle first so
      // its ensureReady() cleanup cannot hand us a stale startPromise when we
      // bring up the replacement below.
      const pendingStart = this.startPromise
      if (pendingStart) {
        await pendingStart.catch(() => {})
      }
      const child = this.child
      this.ready = false

      if (child) {
        // Recycling replaces one process shared by every active session. Fail
        // all parent streams now; otherwise sessions other than the one that
        // triggered recycle can remain attached to a detached old child and
        // wait forever if that child reports exit late (or never reports it).
        this.emit(
          'crash',
          new SandboxError(
            `sandbox supervisor recycled: ${reason}`,
            'sandbox.supervisor.cleanup_failed'
          )
        )
        try {
          if (child.connected) child.send({ type: 'shutdown' } satisfies SupervisorCommand)
        } catch {
          // Fall through to the bounded hard-stop path.
        }

        await Promise.race([
          new Promise<void>((resolve) => child.once('exit', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 2_000))
        ])

        if (this.child === child) {
          try {
            child.kill('SIGKILL')
          } catch {
            // The bounded state reset below still fences stale exit events.
          }
          await Promise.race([
            new Promise<void>((resolve) => child.once('exit', () => resolve())),
            new Promise<void>((resolve) => setTimeout(resolve, 2_000))
          ])
        }

        if (this.child === child) {
          this.child = null
        }
      }
    } finally {
      this.recycling = false
    }

    await this.ensureReady()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    if (!this.child) return
    const child = this.child
    try {
      this.send({ type: 'shutdown' })
    } catch {
      // ignore
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000))
    ])
    if (this.child === child) {
      child.kill()
      this.child = null
    }
    this.ready = false
  }
}

let singleton: SandboxSupervisorManager | null = null

export function getSandboxSupervisorManager(): SandboxSupervisorManager {
  if (!singleton) {
    singleton = new SandboxSupervisorManager()
  }
  return singleton
}

export async function shutdownSandboxSupervisor(): Promise<void> {
  if (!singleton) return
  await singleton.shutdown()
  singleton = null
}

export function isSupervisorIpcMessage(
  value: unknown
): value is SupervisorEvent | SupervisorCommand {
  return isSupervisorEvent(value) || isSupervisorCommand(value)
}
