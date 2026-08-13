import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SafeLoggerImpl, scrubLogString } from '../../src/server/application/safe-logger'

const SECRET = 'sk-ant-safe-logger-secret-value'

test('safe logger scrubs secrets and user paths before every sink', (t) => {
  const logDir = mkdtempSync(join(tmpdir(), 'codetask-safe-logger-'))
  t.after(() => rmSync(logDir, { recursive: true, force: true }))

  const logger = new SafeLoggerImpl({ logDir })
  logger.error(`Bearer ${SECRET} at /Users/private-user/workspace`, {
    authorization: `Bearer ${SECRET}`,
    nested: {
      apiKey: SECRET,
      stderr: `ANTHROPIC_API_KEY=${SECRET}`,
      error: new Error(`provider failed with ${SECRET} in C:\\Users\\private-user\\work`)
    }
  })

  const buffered = JSON.stringify(logger.getBuffer())
  const written = readdirSync(logDir)
    .map((name) => readFileSync(join(logDir, name), 'utf8'))
    .join('\n')

  for (const output of [buffered, written]) {
    assert.doesNotMatch(output, /sk-ant-safe-logger-secret-value/)
    assert.doesNotMatch(output, /private-user/)
    assert.match(output, /REDACTED/)
    assert.match(output, /\[USER\]/)
  }
})

test('string scrubber covers auth headers, cookies, and API-key assignments', () => {
  const value = scrubLogString(
    `Authorization: Bearer ${SECRET}; Cookie=session=${SECRET}; OPENAI_API_KEY=${SECRET}`
  )
  assert.doesNotMatch(value, /sk-ant-safe-logger-secret-value/)
  assert.match(value, /REDACTED/)
})
