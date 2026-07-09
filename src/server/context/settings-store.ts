import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { dataPaths } from '../data-paths'

export class SettingsStore {
  constructor(private readonly dataDir: string) {}

  private settingsPath(): string {
    return dataPaths(this.dataDir).settingsFile
  }

  read(): Record<string, unknown> {
    const path = this.settingsPath()
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[settings] failed to read settings.json, backing up and returning defaults', message)
      try {
        const backupPath = `${path}.corrupt.${Date.now()}`
        renameSync(path, backupPath)
        console.warn('[settings] corrupted settings backed up to', backupPath)
      } catch {
        try { unlinkSync(path) } catch { /* best effort */ }
      }
      return {}
    }
  }

  write(value: Record<string, unknown>): void {
    const path = this.settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmpPath = `${path}.tmp.${Date.now()}`
    try {
      writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8')
      renameSync(tmpPath, path)
    } catch (error) {
      try { unlinkSync(tmpPath) } catch { /* best effort */ }
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[settings] failed to write settings.json', message)
      throw error
    }
  }

  patch(mutator: (file: Record<string, unknown>) => void): void {
    const file = this.read()
    mutator(file)
    this.write(file)
  }
}
