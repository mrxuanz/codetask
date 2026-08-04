#!/usr/bin/env node

import { readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testsRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = join(testsRoot, '..')
const EXCLUDED_PREFIXES = ['business-e2e/fixtures/', 'provider-contract/', 'workflow/']

export function discoverUnitTests() {
  return readdirSync(testsRoot, { recursive: true })
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.split(sep).join('/'))
    .filter((entry) => /\.test\.(?:mjs|ts)$/u.test(entry))
    .filter((entry) => !EXCLUDED_PREFIXES.some((prefix) => entry.startsWith(prefix)))
    .map((entry) => join('tests', entry))
    .sort()
}

export function runUnitTests() {
  const files = discoverUnitTests()
  if (files.length === 0) {
    throw new Error(`No unit tests found under ${relative(repositoryRoot, testsRoot)}`)
  }
  const result = spawnSync(
    process.execPath,
    ['--import', './tests/tsx-tsconfig.mjs', '--import', 'tsx', '--test', ...files],
    { cwd: repositoryRoot, stdio: 'inherit', env: process.env }
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runUnitTests())
}
