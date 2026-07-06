import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertFails,
  loadNative,
  policyForRoleV2,
  runInSandbox,
  sandboxTestsEnabled
} from './sandbox-test-utils.mjs'

function policyWithAttachmentReadRoots(role, workspaceRoot, runtimeRoot, attachmentReadRoots) {
  const policy = policyForRoleV2(role, workspaceRoot, runtimeRoot)
  const seen = new Set(policy.filesystem.allowedReadRoots.map((root) => root.toLowerCase()))
  for (const root of attachmentReadRoots) {
    const resolved = realpathSync(root)
    const key = resolved.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      policy.filesystem.allowedReadRoots.push(resolved)
    }
  }
  return policy
}

async function main() {
  const gate = sandboxTestsEnabled()
  if (!gate.enabled) {
    console.log(`skip: ${gate.reason}`)
    return
  }

  const native = loadNative()
  native.preflight()

  const base = mkdtempSync(join(tmpdir(), 'codeteam-attachment-readroots-'))
  const workspace = join(base, 'workspace')
  const runtime = join(base, 'runtime')
  const attachmentsRoot = join(base, 'attachments', 'thread-1')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(runtime, { recursive: true })
  mkdirSync(attachmentsRoot, { recursive: true })

  const heroPath = join(attachmentsRoot, 'att-hero.png')
  const copiedPath = join(workspace, 'from-attachment.png')
  writeFileSync(heroPath, 'hero-bytes')

  const taskPolicy = policyWithAttachmentReadRoots('task-worker', workspace, runtime, [
    attachmentsRoot
  ])

  const copyCmd =
    process.platform === 'win32'
      ? `copy /Y "${heroPath}" "${copiedPath}"`
      : `cp "${heroPath}" "${copiedPath}"`
  const writeCmd =
    process.platform === 'win32' ? `echo hacked> "${heroPath}"` : `echo hacked > "${heroPath}"`

  const copyResult = await runInSandbox(native, taskPolicy, copyCmd)
  if (copyResult.code !== 0) {
    throw new Error(
      `task-worker could not read attachment into workspace: code=${copyResult.code} stderr=${copyResult.stderr}`
    )
  }
  if (!existsSync(copiedPath)) {
    throw new Error('attachment was not copied into writable workspace')
  }
  if (readFileSync(copiedPath, 'utf8') !== 'hero-bytes') {
    throw new Error('copied attachment content mismatch')
  }

  await assertFails(
    runInSandbox(native, taskPolicy, writeCmd),
    'task-worker cannot write attachment directory'
  )

  if (readFileSync(heroPath, 'utf8') !== 'hero-bytes') {
    throw new Error('attachment file was modified despite write denial')
  }

  rmSync(base, { recursive: true, force: true })
  console.log(`attachment readRoots integration passed on ${process.platform}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
