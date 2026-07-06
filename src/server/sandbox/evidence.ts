import { createHash } from 'crypto'
import type { Readable } from 'stream'
import type { AnySandboxPolicy, SandboxEvidence } from './types'
import { serializeSandboxPolicy } from './wire'

export function sha256Policy(policy: AnySandboxPolicy): string {
  const json = serializeSandboxPolicy(policy)
  return createHash('sha256').update(json).digest('hex')
}

export function readOneJsonLine<T>(stream: Readable, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('sandbox evidence read timeout'))
    }, timeoutMs)

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      cleanup()
      const line = buffer.slice(0, newline).trim()
      if (!line) {
        reject(new Error('sandbox evidence line empty'))
        return
      }
      try {
        resolve(JSON.parse(line) as T)
      } catch (error) {
        reject(
          new Error(
            `sandbox evidence JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      }
    }

    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const onEnd = (): void => {
      cleanup()
      reject(new Error('sandbox evidence stream ended before JSON line'))
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
    }

    stream.on('data', onData)
    stream.on('error', onError)
    stream.on('end', onEnd)
  })
}

export function assertSandboxEvidence(evidence: SandboxEvidence, policy: AnySandboxPolicy): void {
  if (!evidence.active) {
    throw new Error('sandbox helper did not attest active sandbox')
  }
  const expected = sha256Policy(policy)
  if (evidence.policySha256 !== expected) {
    throw new Error('sandbox helper did not attest the requested policy')
  }
}
