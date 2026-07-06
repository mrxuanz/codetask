import { existsSync } from 'fs'
import { join } from 'path'

function packagedAppPath(): string | null {
  const resourcesPath = process.resourcesPath
  if (!resourcesPath) return null
  const asarPath = join(resourcesPath, 'app.asar')
  return existsSync(asarPath) ? asarPath : null
}

export function resolveMainSandboxScript(filename: string): string | null {
  const relative = join('sandbox', filename)
  const candidates: string[] = []

  const appPath = packagedAppPath()
  if (appPath) {
    candidates.push(join(appPath, 'out', 'main', relative))
  }

  candidates.push(
    join(__dirname, '..', 'sandbox', filename),
    join(process.cwd(), 'out', 'main', relative)
  )

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}
