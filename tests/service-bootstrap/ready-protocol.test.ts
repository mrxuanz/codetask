import assert from 'node:assert/strict'
import { openSync, readFileSync, closeSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  announceServiceReady,
  createServiceReadyMessage,
  parseServiceBootstrapArgs,
  parseServiceReadyMessage,
  serializeServiceReadyMessage,
  SERVICE_READY_PROTOCOL_VERSION
} from '../../packages/service-bootstrap/src/index.ts'
import { parseServerCliArgs } from '../../src/main/cli.ts'

test('parseServiceBootstrapArgs reads data-dir, ready-fd, port 0, renderer-dev-url', () => {
  const parsed = parseServiceBootstrapArgs([
    'codetask-service',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--data-dir',
    '/tmp/codetask-data',
    '--ready-fd',
    '3',
    '--renderer-dev-url',
    'http://127.0.0.1:5173'
  ])
  assert.equal(parsed.port, 0)
  assert.equal(parsed.host, '127.0.0.1')
  assert.equal(parsed.dataDir, '/tmp/codetask-data')
  assert.equal(parsed.readyFd, 3)
  assert.equal(parsed.rendererDevUrl, 'http://127.0.0.1:5173')
})

test('parseServerCliArgs exposes bootstrap fields without CODETASK env', () => {
  const parsed = parseServerCliArgs([
    'codetask-server',
    '--serve',
    '--port',
    '0',
    '--data-dir',
    '/var/codetask',
    '--ready-fd',
    '7'
  ])
  assert.equal(parsed.mode, 'server')
  assert.equal(parsed.port, 0)
  assert.equal(parsed.dataDir, '/var/codetask')
  assert.equal(parsed.readyFd, 7)
})

test('ready message round-trips and announceServiceReady writes then closes fd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-fd-'))
  const path = join(dir, 'ready.jsonl')
  const fd = openSync(path, 'w')
  const message = createServiceReadyMessage({
    origin: 'http://127.0.0.1:43127',
    pid: 12345,
    instanceId: 'inst-1'
  })
  assert.equal(message.protocolVersion, SERVICE_READY_PROTOCOL_VERSION)
  assert.equal(message.healthPath, '/api/health')

  announceServiceReady(fd, message)
  const raw = readFileSync(path, 'utf8')
  const parsed = parseServiceReadyMessage(raw)
  assert.deepEqual(parsed, message)
  assert.equal(serializeServiceReadyMessage(message).endsWith('\n'), true)

  assert.throws(() => closeSync(fd), /EBADF|bad file descriptor/i)
  unlinkSync(path)
})

test('parseServiceReadyMessage rejects bad protocol', () => {
  assert.throws(
    () =>
      parseServiceReadyMessage(
        JSON.stringify({
          protocolVersion: 99,
          pid: 1,
          origin: 'http://x',
          healthPath: '/api/health',
          instanceId: 'a'
        })
      ),
    /Unsupported ready protocolVersion/
  )
})
