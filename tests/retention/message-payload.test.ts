import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { DEFAULT_RETENTION_SETTINGS } from '@codetask/contracts'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../../src/server/db'
import {
  hydrateMessagePayload,
  prepareMessagePayloadForStorage,
  shouldExternalizeMessagePayload
} from '../../src/server/retention/message-payload'

test('shouldExternalizeMessagePayload when draft payload exceeds inline limit', () => {
  const payload = {
    draftId: 'd1',
    title: 'Draft',
    summary: 's',
    requirementsContract: { markdown: 'x'.repeat(9000), status: 'pending' }
  }
  assert.equal(shouldExternalizeMessagePayload(payload, 2048), true)
})

test('prepareMessagePayloadForStorage externalizes and hydrates round-trip', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'retention-msg-payload-'))
  const db = createIsolatedTestDatabase(dataDir)
  try {
    const fullPayload = {
      draftId: 'd1',
      sourceMessageId: 'msg-1',
      title: 'Large draft',
      summary: 'summary',
      status: 'editing',
      requirementsContract: { markdown: 'x'.repeat(9000), status: 'pending' },
      acceptance: [{ id: 'a1', given: 'g', when: 'w', then: 't' }]
    }

    const stored = await prepareMessagePayloadForStorage({
      messageId: 'msg-1',
      payload: fullPayload,
      dataDir,
      db,
      settings: { ...DEFAULT_RETENTION_SETTINGS, messagePayloadInlineMaxBytes: 1024 }
    })

    assert.ok(stored.payloadArtifactId)
    assert.ok(stored.payloadJson)
    assert.doesNotMatch(stored.payloadJson!, /xxxx/)

    const hydrated = (await hydrateMessagePayload({
      payloadJson: stored.payloadJson,
      payloadArtifactId: stored.payloadArtifactId,
      dataDir,
      db
    })) as typeof fullPayload

    assert.equal(hydrated.title, 'Large draft')
    assert.equal(hydrated.requirementsContract.markdown.length, 9000)
    assert.equal(hydrated.acceptance.length, 1)
  } finally {
    closeIsolatedTestDatabase(db)
    rmSync(dataDir, { recursive: true, force: true })
  }
})
