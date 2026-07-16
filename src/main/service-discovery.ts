import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import type { BootstrapPaths } from './storage-locator'

export interface DiscoveredServerInfo {
  host: string
  port: number
  url: string
  requestedPort: number
  portChanged: boolean
  mode: 'server'
}

interface RunningServiceRecord extends DiscoveredServerInfo {
  schemaVersion: 1
  pid: number
  instanceId: string
  publishedAt: string
  dataDir?: string
}

let publishedRecord: { path: string; instanceId: string } | null = null

function parseRecord(raw: unknown): RunningServiceRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (
    value.schemaVersion !== 1 ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.instanceId !== 'string' ||
    !value.instanceId ||
    typeof value.publishedAt !== 'string' ||
    typeof value.host !== 'string' ||
    typeof value.port !== 'number' ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.requestedPort !== 'number' ||
    !Number.isInteger(value.requestedPort) ||
    typeof value.portChanged !== 'boolean' ||
    value.mode !== 'server' ||
    typeof value.url !== 'string' ||
    (value.dataDir !== undefined && typeof value.dataDir !== 'string')
  ) {
    return null
  }

  try {
    const url = new URL(value.url)
    if (url.protocol !== 'http:' || Number(url.port || 80) !== value.port) return null
  } catch {
    return null
  }

  return value as unknown as RunningServiceRecord
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function writeRecord(path: string, record: RunningServiceRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

/** Publish a headless service endpoint so the desktop shell can reuse the same runtime. */
export function publishRunningService(
  paths: BootstrapPaths,
  info: DiscoveredServerInfo,
  dataDir?: string
): void {
  const record: RunningServiceRecord = {
    schemaVersion: 1,
    pid: process.pid,
    instanceId: randomUUID(),
    publishedAt: new Date().toISOString(),
    ...info,
    ...(dataDir ? { dataDir: resolve(dataDir) } : {})
  }
  writeRecord(paths.serviceDiscoveryFile, record)
  publishedRecord = { path: paths.serviceDiscoveryFile, instanceId: record.instanceId }
}

/** Return a healthy service from this installation, ignoring stale crash records. */
export async function discoverRunningService(
  paths: BootstrapPaths,
  expectedDataDir?: string
): Promise<DiscoveredServerInfo | null> {
  if (!existsSync(paths.serviceDiscoveryFile)) return null

  let record: RunningServiceRecord | null = null
  try {
    record = parseRecord(JSON.parse(readFileSync(paths.serviceDiscoveryFile, 'utf8')))
  } catch {
    return null
  }
  if (!record || !processIsAlive(record.pid)) return null
  if (expectedDataDir && record.dataDir !== resolve(expectedDataDir)) return null

  try {
    const response = await fetch(`${record.url}/api/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: 'no-store'
    })
    if (!response.ok) return null
    const body = (await response.json()) as { success?: boolean; data?: { status?: string } }
    if (body.success !== true || body.data?.status !== 'ok') return null
  } catch {
    return null
  }

  return {
    host: record.host,
    port: record.port,
    url: record.url,
    requestedPort: record.requestedPort,
    portChanged: record.portChanged,
    mode: 'server'
  }
}

/** Remove only the discovery record published by this process instance. */
export function clearPublishedRunningService(): void {
  const published = publishedRecord
  publishedRecord = null
  if (!published || !existsSync(published.path)) return
  try {
    const current = parseRecord(JSON.parse(readFileSync(published.path, 'utf8')))
    if (current?.instanceId === published.instanceId) unlinkSync(published.path)
  } catch {
    // A corrupt or replaced record does not belong to this process anymore.
  }
}
