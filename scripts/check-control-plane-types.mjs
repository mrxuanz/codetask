#!/usr/bin/env node

/**
 * CI text gate: prevents unsafe type escapes in control-plane code.
 * Checks for: `: any`, `as any`, `as unknown as`, @ts-ignore, @ts-nocheck
 * (Avoid bare `\bany\b` — it false-positives English prose in tests.)
 */

import { resolve } from 'node:path'
import { exit } from 'process'

import { scanSourcePatterns } from './ci/source-pattern-scan.mjs'

const CONTROL_PLANE_DIRS = [
  'src/shared/contracts/control-plane',
  'src/server/domain',
  'src/server/application',
  'src/server/infra/sqlite/control-plane',
  'src/server/http/v3',
  'src/renderer/src/stores',
  'tests/control-plane'
]

const PATTERNS = [
  ':\\s*any\\b',
  '<any>',
  'as\\s+any\\b',
  'as unknown as',
  '@ts-ignore',
  '@ts-nocheck'
]

const repositoryRoot = resolve(import.meta.dirname, '..')

let hasErrors = false

for (const dir of CONTROL_PLANE_DIRS) {
  const matches = scanSourcePatterns({
    repositoryRoot,
    scanPaths: [dir],
    patterns: PATTERNS
  })
  if (matches.length > 0) {
    console.error(`\nUnsafe type escape found in ${dir}:`)
    for (const match of matches) {
      console.error(`${match.file}:${match.line}:${match.text}`)
    }
    hasErrors = true
  }
}

if (hasErrors) {
  console.error('\n❌ unsafe type escape found in control-plane code')
  exit(1)
} else {
  console.log('✅ No unsafe type escapes found in control-plane code')
}
