#!/usr/bin/env node

/**
 * CI text gate: flags `as unknown as` double assertions in production source.
 * Prefer type guards or schema validators instead of double casts.
 */

import { resolve } from 'node:path'
import { exit } from 'process'

import { scanSourcePatterns } from './ci/source-pattern-scan.mjs'

const SCAN_DIRS = ['src']

const PATTERN = 'as unknown as'

const repositoryRoot = resolve(import.meta.dirname, '..')

let hasErrors = false

for (const dir of SCAN_DIRS) {
  const matches = scanSourcePatterns({
    repositoryRoot,
    scanPaths: [dir],
    patterns: [PATTERN]
  })
  if (matches.length > 0) {
    console.error(`\nDouble assertion found in ${dir}:`)
    for (const match of matches) {
      console.error(`${match.file}:${match.line}:${match.text}`)
    }
    hasErrors = true
  }
}

if (hasErrors) {
  console.error('\n❌ as unknown as double assertions found in src/')
  exit(1)
} else {
  console.log('✅ No as unknown as double assertions found in src/')
}
