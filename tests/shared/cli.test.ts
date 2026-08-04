import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCliArgs, parseServerCliArgs } from '../../src/main/cli'

test('packaged smoke mode uses the headless loopback server', () => {
  assert.deepEqual(parseCliArgs(['codetask', '--smoke-test']), {
    mode: 'server',
    host: '127.0.0.1',
    port: 8080,
    smokeTest: true,
    dataDir: undefined,
    readyFd: undefined,
    bootstrapTokenFd: undefined,
    runManifest: undefined,
    rendererDevUrl: undefined,
    masterKeyFile: undefined
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
    smokeTest: false,
    dataDir: undefined,
    readyFd: undefined,
    bootstrapTokenFd: undefined,
    runManifest: undefined,
    rendererDevUrl: undefined,
    masterKeyFile: undefined
  })
})

test('dedicated Node entry is always server mode without requiring --serve', () => {
  assert.deepEqual(parseServerCliArgs(['codetask-server', '--port', '9091']), {
    mode: 'server',
    host: '127.0.0.1',
    port: 9091,
    smokeTest: false,
    dataDir: undefined,
    readyFd: undefined,
    bootstrapTokenFd: undefined,
    runManifest: undefined,
    rendererDevUrl: undefined,
    masterKeyFile: undefined
  })
})

test('server CLI accepts ephemeral port 0', () => {
  const parsed = parseServerCliArgs(['codetask-server', '--port', '0'])
  assert.equal(parsed.port, 0)
  assert.equal(parsed.mode, 'server')
})
