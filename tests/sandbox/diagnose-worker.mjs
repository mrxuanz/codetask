import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function probeRead(label, path) {
  try {
    if (!path) return { label, ok: false, error: 'path missing' }
    if (!existsSync(path)) return { label, path, ok: false, error: 'not found' }
    const stat = readFileSync(path)
    return { label, path, ok: true, bytes: stat.length }
  } catch (error) {
    return {
      label,
      path,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function probeWrite(label, path) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const file = join(path, `.probe-${Date.now()}.txt`)
    writeFileSync(file, 'ok', 'utf8')
    return { label, path: file, ok: true }
  } catch (error) {
    return {
      label,
      path,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function probeSpawn(label, command, args, envExtra = {}) {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...envExtra },
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true
  })
  return {
    label,
    command,
    args,
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? '').slice(0, 2000),
    stderr: (result.stderr ?? '').slice(0, 2000),
    error: result.error?.message
  }
}

async function readInput() {
  const fromEnv = process.env.CODETASK_WORKER_INPUT?.trim()
  if (fromEnv) return JSON.parse(fromEnv)
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) throw new Error('empty worker input')
  return JSON.parse(raw)
}

async function main() {
  const input = await readInput()
  const hostProfile =
    process.env.CODETASK_SANDBOX_HOST_PROFILE ?? input.hostProfile ?? process.env.USERPROFILE ?? ''
  const runtimeRoot = process.env.CODETASK_RUNTIME_ROOT ?? input.runtimeRoot ?? ''
  const workspaceRoot = input.workspaceRoot ?? process.cwd()

  const probes = []

  probes.push({
    label: 'flags',
    outerSandbox: process.env.CODETASK_OUTER_SANDBOX === '1',
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    execPath: process.execPath,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch
  })

  probes.push({
    label: 'env-snapshot',
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    TEMP: process.env.TEMP,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODETASK_RUNTIME_ROOT: runtimeRoot,
    CODETASK_SANDBOX_HOST_PROFILE: process.env.CODETASK_SANDBOX_HOST_PROFILE,
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim())
  })

  probes.push(probeRead('read-workspace', join(workspaceRoot, 'package.json')))
  probes.push(probeRead('read-host-claude-dir', hostProfile ? join(hostProfile, '.claude') : ''))
  probes.push(
    probeRead(
      'read-host-claude-settings',
      hostProfile ? join(hostProfile, '.claude', 'settings.json') : ''
    )
  )

  if (runtimeRoot) {
    probes.push(probeWrite('write-runtime-tmp', join(runtimeRoot, 'tmp')))
    probes.push(
      probeWrite(
        'write-localappdata',
        join(process.env.LOCALAPPDATA ?? join(runtimeRoot, 'AppData', 'Local'), 'codeteam-probe')
      )
    )
  }

  if (input.claudeExe && existsSync(input.claudeExe)) {
    probes.push(probeSpawn('claude-version', input.claudeExe, ['--version']))
    probes.push(
      probeSpawn('claude-version-no-crashpad', input.claudeExe, ['--version'], {
        ELECTRON_DISABLE_CRASH_REPORTER: '1',
        CHROME_CRASHPAD_HANDLER_PID: '0'
      })
    )
  } else {
    probes.push({ label: 'claude-version', ok: false, error: 'claude.exe not found on host' })
  }

  if (input.nodeExe && existsSync(input.nodeExe)) {
    probes.push(probeSpawn('node-version', input.nodeExe, ['-p', 'process.version']))
  }

  const line = JSON.stringify({
    type: 'completed',
    reply: 'diagnose-worker done',
    probes
  })
  process.stdout.write(`${line}\n`)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[diagnose-worker] ${message}\n`)
  process.exit(1)
})
