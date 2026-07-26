#!/usr/bin/env node
/**
 * R4 soak stub (NOT production soak).
 *
 * Runs a short loop of core job create/save/get against temp sqlite and
 * asserts loose heap + DB size bounds. Does not prove flood/OOM or 100-workflow
 * retention under cut-over binary.
 *
 * Usage:
 *   npm run soak:core:stub
 *   node scripts/cutover/soak-core-stub.mjs
 */

import { fail, runTsx } from './lib.mjs'

function main() {
  try {
    runTsx('soak-core-stub.runner.ts', process.argv.slice(2))
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 1
    fail(error instanceof Error ? error.message : String(error), status)
  }
}

main()
