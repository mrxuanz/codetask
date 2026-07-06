import { mkdirSync } from 'fs'
import { app } from 'electron'
import { dirname, join } from 'path'

export function resolveDataDir(): string {
  if (!app.isPackaged) {
    return join(__dirname, '../../data')
  }
  return join(dirname(app.getPath('exe')), 'data')
}

export function ensureDataDir(): string {
  const dir = resolveDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}
