import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPackageBudgets } from './check-package-budget.mjs'

test('package budget fails closed on every measured dimension', () => {
  const budgets = {
    rendererJavaScriptBytes: 10,
    asarBytes: 10,
    asarUnpackedBytes: 10,
    packagedApplicationBytes: 10,
    dependencyNoiseFiles: 0
  }
  assert.doesNotThrow(() =>
    assertPackageBudgets(
      {
        rendererJavaScriptBytes: 10,
        asarBytes: 10,
        asarUnpackedBytes: 10,
        packagedApplicationBytes: 10,
        dependencyNoiseFiles: 0
      },
      budgets
    )
  )
  assert.throws(() =>
    assertPackageBudgets(
      {
        rendererJavaScriptBytes: 11,
        asarBytes: 10,
        asarUnpackedBytes: 10,
        packagedApplicationBytes: 10,
        dependencyNoiseFiles: 0
      },
      budgets
    )
  )
})
