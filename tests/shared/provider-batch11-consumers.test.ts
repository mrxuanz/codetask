import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { listChatCores } from '../../src/server/conversation/cores.ts'
import { getProviderDescriptor } from '../../src/shared/providers/descriptors.ts'
import { cliMcpRootKey, CLI_MCP_ROOT_KEY } from '../../src/server/settings/mcp.ts'
import { cliMcpRootKey as runtimeCliMcpRootKey } from '../../src/server/agent-runtime/mcp.ts'
import { SUPPORTED_CORE_CODES } from '../../src/shared/providers/codes.ts'
import { createProviderRegistry } from '../../src/server/providers/composition.ts'
import { resolveCoreModel } from '../../src/server/conversation/models.ts'
import { DEFAULT_PROVIDERS_CONFIG } from '../../src/shared/providers/settings.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function readSource(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8')
}

test('listChatCores derives metadata from Registry descriptors and discover', async () => {
  const cores = await listChatCores()
  assert.equal(cores.length, SUPPORTED_CORE_CODES.length)
  for (const core of cores) {
    const descriptor = getProviderDescriptor(core.code)
    assert.equal(core.label, descriptor.label)
    assert.equal(core.description, descriptor.description)
    assert.equal(typeof core.readOnlyCapable, 'boolean')
    assert.equal(
      core.readOnlyCapable,
      descriptor.capabilities.supportedProfiles.includes('chat-read')
    )
  }

  const coresSource = readSource('src/server/conversation/cores.ts')
  assert.match(coresSource, /getProviderRegistry/)
  assert.match(coresSource, /driver\.discover/)
  assert.doesNotMatch(coresSource, /CORE_META/)
  assert.doesNotMatch(coresSource, /resolveProviderExecutable/)
})

test('model resolution does not use CORE_MODEL_ENV and prefers ProviderSettings', () => {
  const models = readSource('src/server/conversation/models.ts')
  assert.doesNotMatch(models, /CORE_MODEL_ENV/)
  assert.match(models, /getAppConfig\(\)\.providers/)
  assert.equal(resolveCoreModel('codex', undefined), DEFAULT_PROVIDERS_CONFIG.codex.model)
})

test('MCP root keys come from shared descriptors; no duplicated Maps', () => {
  for (const code of SUPPORTED_CORE_CODES) {
    const expected = getProviderDescriptor(code).mcpRootKey
    assert.equal(cliMcpRootKey(code), expected)
    assert.equal(runtimeCliMcpRootKey(code), expected)
    assert.equal(CLI_MCP_ROOT_KEY[code], expected)
  }

  const settingsMcp = readSource('src/server/settings/mcp.ts')
  const runtimeMcp = readSource('src/server/agent-runtime/mcp.ts')
  assert.match(settingsMcp, /getProviderDescriptor\(coreCode\)\.mcpRootKey/)
  assert.match(runtimeMcp, /getProviderDescriptor\(coreCode\)\.mcpRootKey/)
  assert.doesNotMatch(settingsMcp, /'claude-code':\s*'mcpServers'/)
  assert.doesNotMatch(runtimeMcp, /'claude-code':\s*'mcpServers'/)
})

test('sandbox orchestrator uses driver contributeSandboxPolicy without provider if-chain', () => {
  const orchestrator = readSource('src/server/sandbox/orchestrator-local.ts')
  const readRoots = readSource('src/server/sandbox/provider-read-roots.ts')
  assert.match(orchestrator, /contributeSandboxPolicy/)
  assert.match(orchestrator, /getProviderRegistry\(\)\.get\(input\.coreCode\)/)
  assert.doesNotMatch(orchestrator, /coreCode === 'codex'/)
  assert.doesNotMatch(orchestrator, /runProviderAuthPreflight/)
  assert.doesNotMatch(readRoots, /provider === 'cursorcli'/)
  assert.doesNotMatch(readRoots, /resolveCursorAgentInstallDirs/)
})

test('auth preflight and install dirs are owned directly by Registry drivers', () => {
  const driver = readSource('src/server/providers/driver.ts')
  const composition = readSource('src/server/providers/composition.ts')
  const installation = readSource('src/server/providers/installation.ts')
  const readRoots = readSource('src/server/sandbox/provider-read-roots.ts')
  assert.match(driver, /prepareAuth\(context:/)
  assert.match(driver, /installDirs\(hostEnvironment/)
  assert.match(composition, /new CodexDriver/)
  assert.match(readRoots, /const driver = getProviderRegistry\(\)\.get\(provider\)/)
  assert.match(readRoots, /driver\.installDirs\(hostEnvironment\)/)
  assert.doesNotMatch(installation, /switch \(provider\)/)
  assert.equal(existsSync(join(root, 'src/server/providers/provider-subsystem.ts')), false)
  assert.equal(existsSync(join(root, 'src/server/providers/auth-preflight-registry.ts')), false)
  assert.equal(existsSync(join(root, 'src/server/providers/install-dirs-registry.ts')), false)
  assert.equal(existsSync(join(root, 'src/server/sandbox/provider-auth/preflight.ts')), false)
})

test('role-worker-cursor-job routes through Registry getAgentTurnProvider', () => {
  const worker = readSource('src/sandbox/role-worker-cursor-job.ts')
  assert.match(worker, /getAgentTurnProvider\('cursorcli'\)/)
  assert.doesNotMatch(worker, /providers\/cursor-acp/)
})

test('UI core labels do not hardcode Provider metadata copies', () => {
  const draftForm = readSource('src/renderer/src/lib/draftForm.ts')
  const jobProgress = readSource('src/renderer/src/lib/jobProgress.ts')
  assert.doesNotMatch(draftForm, /CORE_LABELS/)
  assert.match(jobProgress, /getProviderDescriptors/)
  assert.doesNotMatch(jobProgress, /codex:\s*'Codex'/)
})

test('Registry production drivers remain the single registration surface', () => {
  const registry = createProviderRegistry()
  assert.deepEqual(
    registry.list().map((driver) => driver.descriptor.code),
    [...SUPPORTED_CORE_CODES]
  )
  const index = readSource('src/server/agent-runtime/providers/index.ts')
  assert.doesNotMatch(index, /AGENT_TURN_PROVIDERS/)
  assert.match(index, /getProviderRegistry/)
})
