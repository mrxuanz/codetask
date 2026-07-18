import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCliArgs, parseServerCliArgs } from '../../src/main/cli'

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

test('data directory can be selected explicitly for a Linux service deployment', () => {
  assert.deepEqual(parseCliArgs(['codetask', '--serve', '--data-dir', '/var/lib/codetask']), {
    mode: 'server',
    host: '127.0.0.1',
    port: 8080,
    smokeTest: false,
    dataDir: '/var/lib/codetask'
  })
  assert.throws(() => parseCliArgs(['codetask', '--data-dir']), /Invalid data directory/)
  assert.throws(() => parseCliArgs(['codetask', '--data-dir', '--serve']), /Invalid data directory/)
})

test('dedicated Node entry is always server mode without requiring --serve', () => {
  assert.deepEqual(parseServerCliArgs(['codetask-server', '--port', '9091']), {
    mode: 'server',
    host: '127.0.0.1',
    port: 9091,
    smokeTest: false
  })
})
