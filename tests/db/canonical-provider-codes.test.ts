import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migration061CanonicalProviderCodes } from '../../packages/database/src/migrations/canonical-provider-codes.ts'

test('migration 061 rewrites settings provider aliases to canonical codes', () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE app_settings (
      namespace TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.prepare(
    `INSERT INTO app_settings(namespace, value_json, schema_version, revision, updated_at)
     VALUES (?, ?, 1, 1, 1)`
  ).run(
    'agent_defaults',
    JSON.stringify({
      plannerProvider: 'cursorcli',
      sliceVerifierProvider: 'claude-code',
      milestoneVerifierProvider: 'codex'
    })
  )
  db.prepare(
    `INSERT INTO app_settings(namespace, value_json, schema_version, revision, updated_at)
     VALUES (?, ?, 1, 1, 1)`
  ).run(
    'provider_runtime',
    JSON.stringify({
      providers: {
        cursorcli: { enabled: true, executable: { mode: 'auto' }, approveMcps: true },
        'claude-code': { enabled: false, executable: { mode: 'auto' } }
      }
    })
  )
  db.prepare(
    `INSERT INTO app_settings(namespace, value_json, schema_version, revision, updated_at)
     VALUES (?, ?, 1, 1, 1)`
  ).run(
    'agent_mcp',
    JSON.stringify({
      roles: {
        conversation: {
          'claude-code': { mcpServers: { docs: { command: 'x' } } },
          cursorcli: { mcpServers: {} }
        }
      }
    })
  )

  migration061CanonicalProviderCodes.up(db)

  const defaults = JSON.parse(
    (
      db
        .prepare(`SELECT value_json FROM app_settings WHERE namespace = 'agent_defaults'`)
        .get() as {
        value_json: string
      }
    ).value_json
  )
  assert.equal(defaults.plannerProvider, 'cursor')
  assert.equal(defaults.sliceVerifierProvider, 'claude')

  const runtime = JSON.parse(
    (
      db
        .prepare(`SELECT value_json FROM app_settings WHERE namespace = 'provider_runtime'`)
        .get() as {
        value_json: string
      }
    ).value_json
  )
  assert.ok(runtime.providers.cursor)
  assert.ok(runtime.providers.claude)
  assert.equal(runtime.providers.cursorcli, undefined)
  assert.equal(runtime.providers['claude-code'], undefined)

  const mcp = JSON.parse(
    (
      db.prepare(`SELECT value_json FROM app_settings WHERE namespace = 'agent_mcp'`).get() as {
        value_json: string
      }
    ).value_json
  )
  assert.ok(mcp.roles.conversation.claude)
  assert.ok(mcp.roles.conversation.cursor)
  assert.equal(mcp.roles.conversation['claude-code'], undefined)

  db.close()
})
