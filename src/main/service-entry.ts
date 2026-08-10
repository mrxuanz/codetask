import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * electron-vite places the main entry in `out/main/chunks` while the service
 * sidecar is emitted at `out/main/standalone.js`.
 */
export function resolvePackagedServiceEntry(mainDir: string): string {
  const candidates = [join(mainDir, 'standalone.js'), join(mainDir, '..', 'standalone.js')]
  const entry = candidates.find((candidate) => existsSync(candidate))
  if (entry) return entry

  throw new Error(
    `Service entry not found. Checked: ${candidates.join(', ')}. Build the desktop/standalone bundle first.`
  )
}
