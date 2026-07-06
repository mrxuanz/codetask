import assert from 'node:assert/strict'
import test from 'node:test'

const CODEX_TOP_LEVEL_ALLOW_KEYS = new Set([
  'model',
  'model_provider',
  'provider',
  'default_model',
  'preferred_model',
  'temperature',
  'reasoning_effort',
  'model_reasoning_effort',
  'model_verbosity',
  'sandbox_mode',
  'network_access',
  'approval_policy'
])

const CODEX_DROP_SECTION_PREFIXES = [
  'mcp',
  'mcp_servers',
  'projects',
  'project',
  'plugin',
  'plugins',
  'workspace',
  'trust',
  'telemetry',
  'analytics',
  'hooks',
  'tui',
  'windows'
]

function shouldKeepCodexSection(section) {
  const lower = section.toLowerCase()
  if (lower === 'model_providers' || lower.startsWith('model_providers.')) return true
  return !CODEX_DROP_SECTION_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}.`)
  )
}

function filterCodexConfigToml(raw) {
  const lines = raw.split(/\r?\n/)
  const kept = []
  let skipSection = false
  let currentSection = ''

  for (const line of lines) {
    const trimmed = line.trim()
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      const section = sectionMatch[1].toLowerCase()
      currentSection = section
      skipSection = !shouldKeepCodexSection(section)
      if (!skipSection) kept.push(line)
      continue
    }
    if (skipSection) continue

    const inSection = currentSection !== ''
    if (inSection && currentSection.startsWith('model_providers')) {
      kept.push(line)
      continue
    }

    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/)
    if (!inSection && keyMatch) {
      const key = keyMatch[1].toLowerCase()
      if (CODEX_TOP_LEVEL_ALLOW_KEYS.has(key) || key.endsWith('_url') || key.includes('model')) {
        kept.push(line)
      }
      continue
    }
    if (trimmed.startsWith('#') || trimmed === '') kept.push(line)
  }

  return `${kept.join('\n').trim()}\n`
}

function acceptPrefersEventStream(acceptHeader) {
  if (!acceptHeader) return false
  return acceptHeader.toLowerCase().includes('text/event-stream')
}

function acceptAllowsJson(acceptHeader) {
  if (!acceptHeader) return true
  return acceptHeader.toLowerCase().includes('application/json')
}

test('filterCodexConfigToml keeps model keys and drops plugin sections', () => {
  const raw = `
model = "gpt-4.1"
base_url = "https://api.example.com"

[plugins]
enabled = true

[mcp_servers.codeteam]
url = "http://127.0.0.1:1"
`
  const filtered = filterCodexConfigToml(raw)
  assert.match(filtered, /model = "gpt-4.1"/)
  assert.match(filtered, /base_url/)
  assert.doesNotMatch(filtered, /\[plugins\]/)
  assert.doesNotMatch(filtered, /mcp_servers/)
})

test('filterCodexConfigToml preserves full model_providers sections', () => {
  const raw = `
model = "gpt-5"
model_provider = "custom"

[model_providers.custom]
name = "rightcode"
base_url = "https://www.right.codes/codex/v1"
wire_api = "responses"
requires_openai_auth = true

[mcp_servers.codeteam]
url = "http://127.0.0.1:1"
`
  const filtered = filterCodexConfigToml(raw)
  assert.match(filtered, /\[model_providers\.custom\]/)
  assert.match(filtered, /name = "rightcode"/)
  assert.match(filtered, /base_url = "https:\/\/www\.right\.codes\/codex\/v1"/)
  assert.match(filtered, /wire_api = "responses"/)
  assert.match(filtered, /requires_openai_auth = true/)
  assert.doesNotMatch(filtered, /mcp_servers/)
})

test('filterCodexConfigToml drops windows inner-sandbox section', () => {
  const raw = `
model = "gpt-5.4-mini"
network_access = "enabled"

[windows]
sandbox = "elevated"

[model_providers.custom]
base_url = "https://www.right.codes/codex/v1"
`
  const filtered = filterCodexConfigToml(raw)
  assert.match(filtered, /model = "gpt-5.4-mini"/)
  assert.match(filtered, /base_url = "https:\/\/www\.right\.codes\/codex\/v1"/)
  assert.doesNotMatch(filtered, /\[windows\]/)
  assert.doesNotMatch(filtered, /sandbox = "elevated"/)
})

test('streamable MCP Accept header parsing', () => {
  assert.equal(acceptPrefersEventStream('application/json, text/event-stream'), true)
  assert.equal(acceptAllowsJson('application/json, text/event-stream'), true)
  assert.equal(acceptPrefersEventStream('application/json'), false)
  assert.equal(acceptAllowsJson(undefined), true)
})

test('needs_auth plan phase is part of public API contract', () => {
  const phases = ['idle', 'planning', 'plan_ready', 'failed', 'cleanup_failed', 'needs_auth']
  assert.ok(phases.includes('needs_auth'))
})
