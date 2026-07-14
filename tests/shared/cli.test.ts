import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCliArgs } from '../../src/main/cli'

test('packaged smoke mode uses the headless loopback server', () => {
  assert.deepEqual(parseCliArgs(['codetask', '--smoke-test']), {
    mode: 'server',
    host: '127.0.0.1',
    port: 8080,
    smokeTest: true
  })
})

test('desktop and explicit server modes remain unchanged', () => {
  assert.deepEqual(parseCliArgs(['codetask']), {
    mode: 'desktop',
    host: '127.0.0.1',
    port: 3000,
    smokeTest: false
  })
  assert.deepEqual(parseCliArgs(['codetask', '--serve', '--host', '0.0.0.0', '--port', '9090']), {
    mode: 'server',
    host: '0.0.0.0',
    port: 9090,
    smokeTest: false
  })
})
