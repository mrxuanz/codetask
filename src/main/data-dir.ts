import { mkdirSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'

export function resolveDataDir(): string {
  if (!app.isPackaged) {
    return join(__dirname, '../../data')
  }
  return join(app.getPath('userData'), 'data')
}

export function ensureDataDir(): string {
  const dir = resolveDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}
