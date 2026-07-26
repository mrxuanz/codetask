#!/usr/bin/env node
/**
 * Wave 9 cutover step 4: run offline migrator (legacy → core_*).
 *
 * Thin wrapper around `migrateLegacyToCore` in adapters/sqlite.
 * Spawns tsx so TypeScript adapters load without a separate build.
 *
 * Usage:
 *   node scripts/cutover/migrate.mjs --source <legacy.db> --target <core.db>
 */

import { fail, parseArgs, requireArg, runTsx } from './lib.mjs'

function main() {
  try {
    const args = parseArgs()
    const source = requireArg(args, 'source')
    const target = requireArg(args, 'target')
    runTsx('migrate.runner.ts', ['--source', source, '--target', target])
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 1
    fail(error instanceof Error ? error.message : String(error), status)
  }
}

main()
