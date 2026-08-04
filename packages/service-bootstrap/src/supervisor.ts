import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseServiceReadyMessage, type ServiceReadyMessage } from './ready.ts'

export type SpawnServiceOptions = {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  readyTimeoutMs?: number
  killGraceMs?: number
}

export type SupervisedService = {
  ready: ServiceReadyMessage
  child: ChildProcess
  stop: (timeoutMs?: number) => Promise<void>
}

function readReadyFromFd3(child: ChildProcess, timeoutMs: number): Promise<ServiceReadyMessage> {
  const stream = child.stdio[3]
  if (!stream || typeof stream === 'number' || !('on' in stream)) {
    return Promise.reject(new Error('Service child did not expose stdio[3] for ready-fd'))
  }

  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: stream as NodeJS.ReadableStream })
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for service ready after ${timeoutMs}ms`))
    }, timeoutMs)

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(
        new Error(`Service exited before ready (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
      )
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      rl.removeAllListeners()
      child.removeListener('exit', onExit)
      try {
        rl.close()
      } catch {
        // ignore
      }
    }

    child.once('exit', onExit)
    rl.once('line', (line) => {
      try {
        const message = parseServiceReadyMessage(line)
        cleanup()
        resolve(message)
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
    rl.once('error', (error) => {
      cleanup()
      reject(error)
    })
  })
}

async function stopChild(
  child: ChildProcess,
  expectedPid: number,
  timeoutMs: number
): Promise<void> {
  if (child.killed || child.exitCode != null) return
  if (child.pid !== expectedPid) {
    throw new Error(
      `Refusing to stop service: pid mismatch (child=${child.pid} expected=${expectedPid})`
    )
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid === expectedPid && child.exitCode == null) {
        child.kill('SIGKILL')
      }
      resolve()
    }, timeoutMs)

    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

/**
 * Spawn a CodeTask service process and wait for the Batch C ready handshake on fd 3.
 */
export async function spawnSupervisedService(
  options: SpawnServiceOptions
): Promise<SupervisedService> {
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const killGraceMs = options.killGraceMs ?? 10_000
  const args = [...options.args, '--ready-fd', '3']

  const child = spawn(options.command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'inherit', 'inherit', 'pipe']
  })

  if (child.pid == null) {
    throw new Error('Failed to spawn service process')
  }

  try {
    const ready = await readReadyFromFd3(child, readyTimeoutMs)
    if (ready.pid !== child.pid) {
      throw new Error(
        `Ready pid mismatch: ready=${ready.pid} child=${child.pid} instance=${ready.instanceId}`
      )
    }
    return {
      ready,
      child,
      stop: (timeoutMs = killGraceMs) => stopChild(child, ready.pid, timeoutMs)
    }
  } catch (error) {
    if (child.exitCode == null) {
      child.kill('SIGKILL')
    }
    throw error
  }
}
