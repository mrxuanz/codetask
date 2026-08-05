/**
 * Architecture 05 DoD checklist — Settings module cutover.
 * @see docs/架构收口/05-设置模块与配置生效.md §21
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SETTING_NAMESPACES, AGENT_MCP_ROLES } from '../../packages/contracts/src/settings.ts'

const root = join(import.meta.dirname, '../..')

function exists(rel: string): boolean {
  try {
    const st = statSync(join(root, rel))
    return st.isFile() || st.isDirectory()
  } catch {
    return false
  }
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|vue|mjs)$/.test(name)) files.push(full)
  }
  return files
}

describe('architecture 05 DoD', () => {
  it('Settings module lives under packages/server-core/src/modules/settings', () => {
    assert.equal(exists('packages/server-core/src/modules/settings'), true)
    assert.equal(exists('packages/server-core/src/modules/settings/composition.ts'), true)
    assert.equal(
      exists('packages/server-core/src/modules/settings/application/settings-application.ts'),
      true
    )
    assert.equal(exists('packages/server-core/src/modules/settings/http/settings-routes.ts'), true)
    assert.equal(
      exists(
        'packages/server-core/src/modules/settings/infrastructure/sqlite-settings-repository.ts'
      ),
      true
    )
    assert.equal(
      exists('packages/server-core/src/modules/settings/infrastructure/encrypted-secret-store.ts'),
      true
    )
  })

  it('contracts expose four namespaces and settings error codes', () => {
    const settings = readFileSync(join(root, 'packages/contracts/src/settings.ts'), 'utf8')
    assert.deepEqual(
      [...SETTING_NAMESPACES],
      ['agent_defaults', 'agent_prompts', 'agent_mcp', 'provider_runtime']
    )
    assert.ok(AGENT_MCP_ROLES.includes('planner'))
    assert.match(settings, /SETTINGS_ERROR_CODES/)
    assert.match(settings, /settings\.revision_conflict/)
    assert.match(settings, /SecretReferenceSchema|SettingsProviderCodeSchema/)
  })

  it('migration 053 settings namespaces is registered', () => {
    assert.equal(exists('packages/database/src/migrations/settings-namespaces.ts'), true)
    assert.equal(exists('packages/database/src/migrations/settings-namespaces.ts'), true)
    const index = readFileSync(join(root, 'packages/database/src/migrations/all.ts'), 'utf8')
    assert.match(index, /migration053SettingsNamespaces/)
  })

  it('host settings routes no longer expose control-plane or business-skills', () => {
    const routes = readFileSync(join(root, 'src/server/routes/settings.ts'), 'utf8')
    assert.doesNotMatch(routes, /control-plane/)
    assert.doesNotMatch(routes, /business-skills/)
    assert.match(routes, /createSettingsHttpRoutes|getOrComposeSettings/)
    assert.doesNotMatch(routes, /\/storage/)
  })

  it('storage stats live under system API not settings', () => {
    const system = readFileSync(join(root, 'src/server/routes/system.ts'), 'utf8')
    assert.match(system, /\/storage/)
    assert.match(system, /readStorageStats/)
  })

  it('legacy file settings facade is removed', () => {
    assert.equal(exists('src/server/settings/store.ts'), false)
    assert.equal(exists('src/server/settings/control-plane.ts'), false)
    assert.equal(exists('src/server/settings/business-skills.ts'), false)
    assert.equal(exists('src/server/settings/prompts.ts'), false)
    assert.equal(exists('src/server/settings/providers.ts'), false)
    for (const file of walk(join(root, 'src/server'))) {
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /readSettingsFile|writeSettingsFile|patchSettingsFile/)
    }
  })

  it('host composes Settings module with secret store', () => {
    const service = readFileSync(join(root, 'src/server/settings/service.ts'), 'utf8')
    assert.match(service, /composeSettingsModule/)
    assert.match(service, /getOrComposeSettings/)
    assert.match(service, /createFileSecretKeyProvider|masterKey|authSecret/)
    assert.doesNotMatch(service, /CODETASK_SETTINGS_MASTER_KEY/)
    assert.doesNotMatch(service, /class SettingsHost/)
  })

  it('planner MCP is a distinct role (not conversation alias)', () => {
    assert.ok(AGENT_MCP_ROLES.includes('planner'))
    assert.ok(AGENT_MCP_ROLES.includes('conversation'))
    assert.ok(AGENT_MCP_ROLES.includes('task'))
    assert.ok(AGENT_MCP_ROLES.includes('verification'))
    const agentMcp = readFileSync(
      join(root, 'packages/server-core/src/modules/settings/domain/agent-mcp.ts'),
      'utf8'
    )
    assert.match(agentMcp, /AGENT_MCP_ROLE_LIST|AGENT_MCP_ROLES/)
    assert.doesNotMatch(agentMcp, /planner.*conversation|conversation.*planner.*reuse/i)
  })

  it('agent runner does not live-read MCP settings mid-turn', () => {
    const runner = readFileSync(join(root, 'src/server/agent-runtime/runner.ts'), 'utf8')
    assert.doesNotMatch(runner, /resolveUserMcpServersMap/)
    assert.match(runner, /userMcpServers \?\? \{\}/)
  })

  it('conversation captures settings snapshot at enqueue', () => {
    const app = readFileSync(
      join(
        root,
        'packages/server-core/src/modules/conversation/application/conversation-application.ts'
      ),
      'utf8'
    )
    assert.match(app, /captureSettingsForTurn/)
    assert.match(app, /settingsSnapshotJson/)
    const composition = readFileSync(
      join(root, 'packages/server-core/src/modules/conversation/composition.ts'),
      'utf8'
    )
    assert.match(composition, /captureSettingsForTurn/)
  })

  it('renderer settings client uses typed settings APIs with CAS', () => {
    const api = readFileSync(join(root, 'apps/web/src/api/settings.ts'), 'utf8')
    assert.match(api, /\/api\/settings\/agent-defaults/)
    assert.match(api, /\/api\/settings\/prompts/)
    assert.match(api, /\/api\/settings\/mcp/)
    assert.match(api, /\/api\/settings\/providers/)
    assert.match(api, /\/api\/settings\/secrets/)
    assert.match(api, /expectedRevision/)
    assert.doesNotMatch(api, /\/api\/settings\/control-plane/)
    assert.doesNotMatch(api, /\/api\/settings\/business-skills/)
    const storage = readFileSync(join(root, 'apps/web/src/api/storage.ts'), 'utf8')
    assert.match(storage, /\/api\/system\/storage/)
    const page = readFileSync(join(root, 'apps/web/src/pages/home/SettingsPage.vue'), 'utf8')
    assert.match(page, /secrets/)
    assert.match(page, /fetchSecrets|putSecret/)
    assert.doesNotMatch(page, /controlPlane|BusinessSkills/)
  })

  it('execution binds work and verification attempts to frozen job settings', () => {
    assert.equal(
      exists('packages/server-core/src/modules/execution/job/application/job-settings-snapshot.ts'),
      true
    )
    const execute = readFileSync(
      join(root, 'packages/server-core/src/modules/execution/work/application/execute-work.ts'),
      'utf8'
    )
    assert.match(execute, /readJobExecutionSettings|taskMcpFromJobSettings/)
    const verify = readFileSync(
      join(
        root,
        'packages/server-core/src/modules/execution/verification/application/verify-slice.ts'
      ),
      'utf8'
    )
    assert.match(verify, /settingsBinding|settingsHash/)
    assert.match(verify, /verificationMcpFromJobSettings|verifierPromptFromJobSettings/)
  })

  it('conversation host does not live-read system prompt', () => {
    const design = readFileSync(join(root, 'src/server/design-module.ts'), 'utf8')
    assert.doesNotMatch(design, /resolveChatSystemPrompt/)
    assert.match(design, /resolveSystemPrompt:\s*\(\)\s*=>\s*''/)
    assert.match(design, /captureSettingsForTurn/)
  })

  it('SettingsStore no longer exposes file-style read/patch', () => {
    const store = readFileSync(join(root, 'src/server/context/settings-store.ts'), 'utf8')
    assert.doesNotMatch(store, /NAMESPACE_TO_PROPERTY/)
    assert.doesNotMatch(store, /\bread\(\):\s*Record/)
    assert.doesNotMatch(store, /\bpatch\(mutator/)
    assert.match(store, /readNamespace/)
    assert.match(store, /writeNamespace/)
  })

  it('AppConfig owns retention defaults', () => {
    const config = readFileSync(join(root, 'src/server/config/app-config.ts'), 'utf8')
    assert.match(config, /retention/)
    assert.match(config, /DEFAULT_RETENTION_SETTINGS/)
    const retention = readFileSync(join(root, 'src/server/retention/settings.ts'), 'utf8')
    assert.match(retention, /AppConfig/)
    assert.doesNotMatch(retention, /SettingsStore/)
  })
})
