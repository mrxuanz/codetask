#!/usr/bin/env node
/**
 * Wave 9 cutover step 6: boot new composition root (smoke).
 *
 * Calls `createApplication({ mode: 'memory' })` and prints ok. Does not bind ports or touch
 * production data directories.
 *
 * Usage:
 *   node scripts/cutover/boot-new.mjs
 */

import { fail, runTsx } from './lib.mjs'

function main() {
  try {
    runTsx('boot-new.runner.ts', [])
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 1
    fail(error instanceof Error ? error.message : String(error), status)
  }
}

main()
