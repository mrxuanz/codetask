import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export class SettingsStore {
  constructor(private readonly dataDir: string) {}

  private settingsPath(): string {
    return join(this.dataDir, 'settings.json')
  }

  read(): Record<string, unknown> {
    const path = this.settingsPath()
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  write(value: Record<string, unknown>): void {
    mkdirSync(this.dataDir, { recursive: true })
    writeFileSync(this.settingsPath(), JSON.stringify(value, null, 2), 'utf-8')
  }

  patch(mutator: (file: Record<string, unknown>) => void): void {
    const file = this.read()
    mutator(file)
    this.write(file)
  }
}
