import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Provider subsystem process.env allowlist (PRU-12-01).
 * Only the server-level host snapshot boundary may read process.env.
 * Forbidden: CodeTask Provider config keys (BIN / MODEL / Cursor endpoint / approve).
 */

const SCAN_ROOTS = [join(process.cwd(), 'src/server')]

const ALLOWED_PROCESS_ENV_FILES = new Set([
  join(process.cwd(), 'src/server/host-environment.ts')
])

function collectFiles(entry: string): string[] {
  if (!existsSync(entry)) return []
  const stat = statSync(entry)
  if (stat.isFile()) return entry.endsWith('.ts') ? [entry] : []
  const files: string[] = []
  for (const name of readdirSync(entry)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    files.push(...collectFiles(join(entry, name)))
  }
  return files
}

test('server runtime reads process.env only at the host environment boundary', () => {
  const offenders: Array<{ file: string; line: number; text: string }> = []

  for (const root of SCAN_ROOTS) {
    for (const file of collectFiles(root)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? ''
        const trimmed = text.trim()
        if (
          /process\.env\b/.test(text) &&
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('/**') &&
          !trimmed.startsWith('*') &&
          !ALLOWED_PROCESS_ENV_FILES.has(file)
        ) {
          offenders.push({ file, line: i + 1, text: trimmed })
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    offenders.map((o) => `${o.file}:${o.line}: ${o.text}`).join('\n') || 'no offenders'
  )
})

test('Provider configuration no longer exposes CODETASK env entry points', () => {
  const forbidden =
    /CODETASK_(?:CODEX|CLAUDE|OPENCODE|CURSOR)_(?:BIN|MODEL|AUTH_PATH|CONFIG_DIR|INSTALL_DIR|AGENT_DIR|API_ENDPOINT|APPROVE_MCPS)|CODETASK_MODEL_|CODETASK_PROVIDER_AUTH_MODE/
  const offenders: string[] = []
  for (const root of SCAN_ROOTS) {
    for (const file of collectFiles(root)) {
      const source = readFileSync(file, 'utf8')
      if (forbidden.test(source) && !file.endsWith('providers/environment.ts')) {
        offenders.push(file)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('role-workers do not use CODETASK_OUTER_SANDBOX as a module decision source', () => {
  for (const relative of [
    'src/sandbox/role-worker.ts',
    'src/sandbox/role-worker-common.ts',
    'src/sandbox/role-worker-cursor-job.ts'
  ]) {
    const source = readFileSync(join(process.cwd(), relative), 'utf8')
    assert.doesNotMatch(
      source,
      /process\.env\.CODETASK_OUTER_SANDBOX/,
      `${relative} must not read CODETASK_OUTER_SANDBOX`
    )
    assert.match(source, /outerSandbox:\s*true/)
  }
})

test('catalog definitions no longer declare executableEnv or modelEnv', () => {
  for (const relative of [
    'src/server/providers/codex/descriptor.ts',
    'src/server/providers/claude/descriptor.ts',
    'src/server/providers/opencode/descriptor.ts',
    'src/server/providers/cursor/descriptor.ts',
    'src/server/providers/types.ts',
    'src/server/providers/owned-env.ts'
  ]) {
    const source = readFileSync(join(process.cwd(), relative), 'utf8')
    assert.doesNotMatch(source, /executableEnv/)
    assert.doesNotMatch(source, /modelEnv/)
    assert.doesNotMatch(source, /CODETASK_.*_BIN/)
    assert.doesNotMatch(source, /CODETASK_MODEL_/)
  }
})

test('deprecated PRU-12-07 policy re-export files are deleted', () => {
  for (const relative of [
    'src/server/agent-runtime/providers/codex-policy.ts',
    'src/server/agent-runtime/providers/claude-policy.ts',
    'src/server/agent-runtime/providers/cursor-policy.ts'
  ]) {
    assert.equal(existsSync(join(process.cwd(), relative)), false, relative)
  }
})
