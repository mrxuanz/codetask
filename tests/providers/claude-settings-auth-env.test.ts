import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyClaudeSettingsAuthEnv,
  buildClaudeTurnOptions,
  resolveClaudeSettingSources
} from '../../src/server/providers/claude/turn-options'
import {
  isAllowedClaudeSettingsEnvKey,
  prepareClaudeRuntimeProfile,
  readClaudeSettingsEnv,
  resolveClaudeSettingsAuthEnv
} from '../../src/server/sandbox/provider-auth'
import { resolveHostProfilePaths } from '../../src/server/sandbox/provider-auth/paths'

test('isAllowedClaudeSettingsEnvKey only allows Anthropic auth keys', () => {
  assert.equal(isAllowedClaudeSettingsEnvKey('ANTHROPIC_AUTH_TOKEN'), true)
  assert.equal(isAllowedClaudeSettingsEnvKey('ANTHROPIC_BASE_URL'), true)
  assert.equal(isAllowedClaudeSettingsEnvKey('CLAUDE_CODE_OAUTH_TOKEN'), true)
  assert.equal(isAllowedClaudeSettingsEnvKey('HOME'), false)
  assert.equal(isAllowedClaudeSettingsEnvKey('PATH'), false)
  assert.equal(isAllowedClaudeSettingsEnvKey('CLAUDE_CONFIG_DIR'), false)
  assert.equal(isAllowedClaudeSettingsEnvKey('CODETASK_FOO'), false)
})

test('readClaudeSettingsEnv filters to whitelist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codetask-claude-settings-env-'))
  try {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'tok',
          ANTHROPIC_BASE_URL: 'https://example.test',
          HOME: '/evil',
          PATH: '/evil/bin',
          CODETASK_X: '1',
          EMPTY: '   '
        }
      }),
      'utf8'
    )
    assert.deepEqual(readClaudeSettingsEnv(settingsPath), {
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://example.test'
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prepareClaudeRuntimeProfile injects settings auth env and marks material present', () => {
  const home = mkdtempSync(join(tmpdir(), 'codetask-claude-home-'))
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-claude-runtime-'))
  try {
    const claudeDir = join(home, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sandbox-tok',
          ANTHROPIC_BASE_URL: 'https://proxy.example'
        }
      }),
      'utf8'
    )

    const profile = prepareClaudeRuntimeProfile({
      runtimeRoot,
      hostEnvironment: { HOME: home }
    })

    assert.equal(profile.environment.ANTHROPIC_AUTH_TOKEN, 'sandbox-tok')
    assert.equal(profile.environment.ANTHROPIC_BASE_URL, 'https://proxy.example')
    assert.equal(profile.environment.HOME, home)
    assert.equal(profile.environment.CLAUDE_CONFIG_DIR, claudeDir)
    assert.equal(profile.diagnostics.authMaterialPresent, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('outer-sandbox turn options use user settingSources and re-inject settings auth', () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-claude-turn-'))
  try {
    assert.deepEqual(resolveClaudeSettingSources(true), ['user'])

    const injected = applyClaudeSettingsAuthEnv(
      { KEEP: '1', ANTHROPIC_AUTH_TOKEN: 'stripped-should-overwrite' },
      { ANTHROPIC_AUTH_TOKEN: 'from-settings', ANTHROPIC_BASE_URL: 'https://x' }
    )
    assert.equal(injected.KEEP, '1')
    assert.equal(injected.ANTHROPIC_AUTH_TOKEN, 'from-settings')
    assert.equal(injected.ANTHROPIC_BASE_URL, 'https://x')

    const plan = buildClaudeTurnOptions(
      {
        provider: 'claude',
        role: 'slice-verifier',
        cwd: runtimeRoot,
        runtimeRoot,
        prompt: 'verify',
        capabilityProfile: 'verifier-sandbox'
      },
      { outerSandbox: true }
    )
    assert.deepEqual([...plan.settingSources], ['user'])
    assert.equal(plan.outerSandbox, true)

    // Direct conversation still loads full sources.
    const conversation = buildClaudeTurnOptions(
      {
        provider: 'claude',
        role: 'conversation',
        cwd: runtimeRoot,
        runtimeRoot,
        prompt: 'hi',
        capabilityProfile: 'chat-write'
      },
      { outerSandbox: false }
    )
    assert.deepEqual([...conversation.settingSources], ['user', 'project', 'local'])
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})

test('resolveClaudeSettingsAuthEnv reads host profile settings', () => {
  const host = resolveHostProfilePaths()
  const env = resolveClaudeSettingsAuthEnv(host)
  assert.equal(typeof env, 'object')
  for (const key of Object.keys(env)) {
    assert.equal(isAllowedClaudeSettingsEnvKey(key), true)
  }
})
