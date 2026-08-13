import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertKnownNpmLicenses,
  dependencyLicense,
  npmDependencies,
  renderReport
} from './generate-third-party-dependencies.mjs'

test('lockfile inventory resolves every npm dependency license', () => {
  const dependencies = npmDependencies()

  assert.ok(dependencies.length > 0)
  assert.doesNotThrow(() => assertKnownNpmLicenses(dependencies))
  assert.equal(
    dependencies.some((dependency) => dependency.license === 'UNKNOWN'),
    false
  )
})

test('lockfile license metadata covers optional packages not installed on this platform', () => {
  assert.equal(dependencyLicense('node_modules/@esbuild/linux-x64', { license: 'MIT' }), 'MIT')
})

test('generated report documents its fail-closed license source', () => {
  const report = renderReport()

  assert.match(report, /lockfile metadata with installed package manifests as a fallback/)
  assert.doesNotMatch(report, /\| UNKNOWN \|/)
})
