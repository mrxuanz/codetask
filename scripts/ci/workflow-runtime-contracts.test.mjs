import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const buildWorkflow = readFileSync(
  new URL('../../.github/workflows/build.yml', import.meta.url),
  'utf8'
)
const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const sandboxWorkflow = readFileSync(
  new URL('../../.github/workflows/sandbox.yml', import.meta.url),
  'utf8'
)

const serialRustTest =
  'cargo test --manifest-path native/Cargo.toml --no-fail-fast -- --test-threads=1'

test('Linux package smoke runs Electron under a virtual display', () => {
  assert.match(buildWorkflow, /inputs\.smoke-unpacked && runner\.os == 'Linux'/)
  assert.match(
    buildWorkflow,
    /xvfb-run --auto-servernum node scripts\/package-smoke\.mjs --dist dist/
  )
  assert.match(buildWorkflow, /inputs\.smoke-unpacked && runner\.os != 'Linux'/)
})

test('standalone Node smoke runs separately from the Electron display smoke', () => {
  assert.match(buildWorkflow, /Smoke standalone Node service without a display/)
  assert.match(buildWorkflow, /npm run smoke:standalone:ci/)
  assert.match(buildWorkflow, /standalone-smoke\.log/)
})

test('release builds package and smoke an ncc + SEA service artifact', () => {
  assert.match(buildWorkflow, /Package ncc \+ SEA standalone service/)
  assert.match(buildWorkflow, /npm run package:server:sea/)
  assert.match(buildWorkflow, /server-sea-smoke\.log/)
  assert.match(buildWorkflow, /dist\/\*\.tar\.gz/)
})

test('Rust workspace tests are serialized without skipping failures', () => {
  assert.ok(ciWorkflow.includes(serialRustTest))
  assert.ok(sandboxWorkflow.includes(serialRustTest))
  assert.match(
    sandboxWorkflow,
    /cargo test --manifest-path native\/Cargo\.toml --release --no-fail-fast -- --test-threads=1/
  )
})
