import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createServiceReadyMessage,
  serializeServiceReadyMessage,
  spawnSupervisedService
} from '../../packages/service-bootstrap/src/index.ts'

test('spawnSupervisedService waits for ready-fd and stops matching pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supervised-service-'))
  const script = join(dir, 'fake-service.mjs')
  writeFileSync(
    script,
    `
import { writeSync, closeSync } from 'node:fs'
const fdFlag = process.argv.indexOf('--ready-fd')
const fd = Number(process.argv[fdFlag + 1])
const message = {
  protocolVersion: 1,
  pid: process.pid,
  origin: 'http://127.0.0.1:9',
  healthPath: '/api/health',
  instanceId: 'test-instance'
}
writeSync(fd, JSON.stringify(message) + '\\n')
closeSync(fd)
setInterval(() => {}, 60_000)
`
  )

  try {
    const supervised = await spawnSupervisedService({
      command: process.execPath,
      args: [script],
      readyTimeoutMs: 5_000,
      killGraceMs: 2_000
    })
    assert.equal(supervised.ready.instanceId, 'test-instance')
    assert.equal(supervised.ready.pid, supervised.child.pid)
    assert.equal(supervised.ready.origin, 'http://127.0.0.1:9')
    await supervised.stop()
    assert.ok(supervised.child.exitCode != null || supervised.child.killed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('serializeServiceReadyMessage stays newline-terminated for readline', () => {
  const message = createServiceReadyMessage({ origin: 'http://127.0.0.1:1', instanceId: 'x' })
  assert.match(serializeServiceReadyMessage(message), /\n$/)
})
