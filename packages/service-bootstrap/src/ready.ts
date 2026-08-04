import { randomUUID } from 'node:crypto'
import { writeSync, closeSync } from 'node:fs'

/** Ready handshake protocol for Electron/parent process supervision (Batch C). */
export const SERVICE_READY_PROTOCOL_VERSION = 1 as const

export type ServiceReadyMessage = {
  protocolVersion: typeof SERVICE_READY_PROTOCOL_VERSION
  pid: number
  origin: string
  healthPath: '/api/health'
  instanceId: string
}

export function createServiceReadyMessage(input: {
  origin: string
  pid?: number
  instanceId?: string
}): ServiceReadyMessage {
  return {
    protocolVersion: SERVICE_READY_PROTOCOL_VERSION,
    pid: input.pid ?? process.pid,
    origin: input.origin,
    healthPath: '/api/health',
    instanceId: input.instanceId ?? randomUUID()
  }
}

export function serializeServiceReadyMessage(message: ServiceReadyMessage): string {
  return `${JSON.stringify(message)}\n`
}

export function parseServiceReadyMessage(raw: string): ServiceReadyMessage {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('Empty ready message')
  const parsed = JSON.parse(trimmed) as Partial<ServiceReadyMessage>
  if (parsed.protocolVersion !== SERVICE_READY_PROTOCOL_VERSION) {
    throw new Error(`Unsupported ready protocolVersion: ${String(parsed.protocolVersion)}`)
  }
  if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error('Ready message pid must be a positive integer')
  }
  if (typeof parsed.origin !== 'string' || !/^https?:\/\//.test(parsed.origin)) {
    throw new Error('Ready message origin must be an http(s) URL')
  }
  if (parsed.healthPath !== '/api/health') {
    throw new Error(
      `Ready message healthPath must be /api/health, got ${String(parsed.healthPath)}`
    )
  }
  if (typeof parsed.instanceId !== 'string' || !parsed.instanceId.trim()) {
    throw new Error('Ready message instanceId must be a non-empty string')
  }
  return {
    protocolVersion: SERVICE_READY_PROTOCOL_VERSION,
    pid: parsed.pid,
    origin: parsed.origin,
    healthPath: '/api/health',
    instanceId: parsed.instanceId.trim()
  }
}

/**
 * Write one ready JSON line to the given fd and close it.
 * Safe no-op when fd is undefined/null.
 */
export function announceServiceReady(
  fd: number | undefined | null,
  message: ServiceReadyMessage
): void {
  if (fd == null || !Number.isInteger(fd) || fd < 0) return
  const payload = serializeServiceReadyMessage(message)
  try {
    writeSync(fd, payload)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // fd may already be closed by the parent
    }
  }
}
