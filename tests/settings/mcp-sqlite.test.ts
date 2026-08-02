import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type Database from 'better-sqlite3'
import { MCP_ROOT_KEYS } from '@codetask/server-core/modules/settings'
import {
  bootstrapRuntime,
  getAppContext,
  resetAppContextForTests
} from '../../src/server/bootstrap'
import { getOrComposeSettings } from '../../src/server/settings/service'

test('MCP configuration is stored in SQLite agent_mcp namespace', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-mcp-sqlite-'))
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })
  bootstrapRuntime({ dataDir })
  const app = getOrComposeSettings(getAppContext()).app
  app.putSecret('API_TOKEN', 'stored-directly-in-sqlite')
  const current = app.getMcp()
  const rootKey = MCP_ROOT_KEYS.codex
  const settings = structuredClone(current.settings)
  settings.roles.conversation.codex[rootKey] = {
    docs: {
      command: 'docs-server',
      env: { API_TOKEN: { $secret: 'API_TOKEN' } }
    }
  }
  await app.updateMcp(current.revision, settings)

  const loaded = app.getMcp()
  assert.deepEqual(loaded.settings.roles.conversation.codex[rootKey], {
    docs: {
      command: 'docs-server',
      env: { API_TOKEN: { $secret: 'API_TOKEN', configured: true } }
    }
  })
  const sqlite = (getAppContext().db as unknown as { $client?: Database.Database }).$client
  const row = sqlite
    ?.prepare(`SELECT value_json FROM app_settings WHERE namespace = ?`)
    .get('agent_mcp') as { value_json: string } | undefined
  assert.match(row?.value_json ?? '', /\$secret/)
  assert.match(row?.value_json ?? '', /API_TOKEN/)
  assert.equal(existsSync(join(dataDir, 'mcp-secrets.json')), false)
  assert.equal(existsSync(join(dataDir, 'secrets')), false)
})

test('settings capture normalizes canonical provider aliases to host MCP keys', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-settings-provider-alias-'))
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })
  bootstrapRuntime({ dataDir })
  const app = getOrComposeSettings(getAppContext()).app
  const current = app.getMcp()
  const settings = structuredClone(current.settings)
  settings.roles.conversation['claude-code'].mcpServers = {
    docs: { command: 'docs-server' }
  }
  settings.roles.planner.cursorcli.mcpServers = {
    planner: { command: 'planner-server' }
  }
  await app.updateMcp(current.revision, settings)

  const conversation = app.captureConversationSettings('claude')
  assert.deepEqual(conversation.mcpServers, { docs: { command: 'docs-server' } })

  const design = app.captureDesignSettings('cursor')
  assert.deepEqual(design.mcpServers, { planner: { command: 'planner-server' } })

  const execution = app.captureExecutionSettings('claude', 'cursor')
  assert.equal(typeof execution.taskMcpServers, 'object')
  assert.equal(typeof execution.verificationMcpServers, 'object')
})
