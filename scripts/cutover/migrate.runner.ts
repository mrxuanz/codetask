/**
 * Thin TS entry for offline migrator (spawned by migrate.mjs).
 *
 * Usage (via wrapper):
 *   node scripts/cutover/migrate.mjs --source <legacy.db> --target <core.db>
 */

import { migrateLegacyToCore } from '../../src/server/adapters/sqlite/index.ts'

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function requireArg(args: Record<string, string | true>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`missing required --${name}`)
  }
  return value.trim()
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const sourcePath = requireArg(args, 'source')
  const targetPath = requireArg(args, 'target')
  const report = migrateLegacyToCore({ sourcePath, targetPath })
  console.log(
    JSON.stringify(
      {
        ok: true,
        step: 'migrate',
        ...report
      },
      null,
      2
    )
  )
}

main()
