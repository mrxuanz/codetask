#!/usr/bin/env node
/**
 * Fail fast with a clear message when the running Node major version
 * does not match the repository pin (.node-version / package engines).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function readPinnedMajor() {
  try {
    const raw = readFileSync(join(root, '.node-version'), 'utf8').trim()
    const major = Number.parseInt(raw.split('.')[0] ?? '', 10)
    if (Number.isFinite(major)) return major
  } catch {
    // fall through
  }
  return 24
}

const requiredMajor = readPinnedMajor()
const currentMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)

if (currentMajor !== requiredMajor) {
  console.error(
    `[node] This repository requires Node.js ${requiredMajor}.x (see .node-version). ` +
      `Current version is ${process.versions.node}. ` +
      `Install Node ${requiredMajor}.x and retry; do not run native tests on the wrong ABI.`
  )
  process.exit(1)
}
