import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rootCertificates } from 'node:tls'
import test from 'node:test'

const WINDOWS_SYSTEM_ENV_KEYS = [
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'PROGRAMDATA',
  'ProgramData',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'PUBLIC',
  'ALLUSERSPROFILE'
]

function materializeSandboxTlsCaBundle(runtimeRoot) {
  const configDir = join(runtimeRoot, 'config')
  const caPath = join(configDir, 'ca-bundle.pem')
  mkdirSync(configDir, { recursive: true })
  if (!existsSync(caPath)) {
    writeFileSync(caPath, `${rootCertificates.join('\n')}\n`, 'utf8')
  }
  return caPath
}

function buildSandboxEnvWindows(runtimeRoot, providerEnv = {}) {
  const env = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    CODETASK_OUTER_SANDBOX: '1',
    CODETASK_RUNTIME_ROOT: runtimeRoot,
    ...providerEnv
  }
  for (const key of WINDOWS_SYSTEM_ENV_KEYS) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  env.SSL_CERT_FILE = materializeSandboxTlsCaBundle(runtimeRoot)
  return env
}

test(
  'buildSandboxEnv materializes SSL_CERT_FILE CA bundle on Windows',
  { skip: process.platform !== 'win32' },
  (t) => {
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'codetask-sandbox-env-'))
    t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }))

    const env = buildSandboxEnvWindows(runtimeRoot, {
      HOME: process.env.USERPROFILE,
      USERPROFILE: process.env.USERPROFILE
    })

    assert.ok(env.SSL_CERT_FILE)
    assert.ok(existsSync(env.SSL_CERT_FILE))
    if (process.env.PROGRAMDATA) {
      assert.equal(env.PROGRAMDATA, process.env.PROGRAMDATA)
    }
  }
)
