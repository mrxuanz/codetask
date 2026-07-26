#!/usr/bin/env node
/**
 * Wave 9 cutover step 5: run data validator on core_* DB.
 *
 * Usage:
 *   node scripts/cutover/validate.mjs --db <core.db>
 */

import { fail, parseArgs, requireArg, runTsx } from './lib.mjs'

function main() {
  try {
    const args = parseArgs()
    const db = requireArg(args, 'db')
    runTsx('validate.runner.ts', ['--db', db])
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 1
    fail(error instanceof Error ? error.message : String(error), status)
  }
}

main()
