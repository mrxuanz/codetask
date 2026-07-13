#!/usr/bin/env node
/**
 * Migration preflight: validate DB path exists and schema generation is readable.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/preflight.ts --db <path>
 */

import { parseArgs, requireArg, runPreflight } from './migration-lib'

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = requireArg(args, 'db')
  const result = runPreflight(dbPath)
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify(result, null, 2))
}

main()
