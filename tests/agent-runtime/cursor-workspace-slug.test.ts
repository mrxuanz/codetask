import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  materializeCursorMcpApprovals,
  resolveCursorWorkspaceProjectSlug,
  slugifyCursorProjectPath
} from '../../src/server/agent-runtime/cursor-acp/cursor-workspace'
import { buildCursorAcpCliArgs } from '../../src/server/providers/cursor/turn-plan'

test('slugifyCursorProjectPath handles Windows and POSIX workspace paths', () => {
  assert.equal(
    slugifyCursorProjectPath('E:\\tasktest\\cli-bench\\swift-ridge-8818'),
    'E-tasktest-cli-bench-swift-ridge-8818'
  )
  assert.equal(slugifyCursorProjectPath('/home/user/my-project'), 'home-user-my-project')
})

test('resolveCursorWorkspaceProjectSlug slugifies a non-git workspace path', () => {
  // Use a path that cannot resolve to this repo's .git via dirname walking.
  const workspace = '/tmp/codetask-cursor-slug-fixture/my-project'
  assert.equal(
    resolveCursorWorkspaceProjectSlug(workspace),
    'tmp-codetask-cursor-slug-fixture-my-project'
  )
})

test('outer-sandbox Cursor ACP CLI relies on --approve-mcps', () => {
  const args = buildCursorAcpCliArgs({
    outerSandbox: true,
    cwd: '/tmp/codetask-cursor-sandbox-fixture',
    approveMcps: true
  })
  assert.ok(args.includes('--approve-mcps'))
  assert.ok(args.includes('acp'))
})

test('materializeCursorMcpApprovals writes under HOME/.cursor/projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-ok-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  try {
    const result = await materializeCursorMcpApprovals({
      cwd: workspace,
      servers: [{ name: 'codeteam-manager', type: 'http', url: 'http://127.0.0.1:9/mcp' }],
      env: { HOME: root }
    })
    assert.ok(result?.approvalsPath)
    assert.equal(existsSync(result!.approvalsPath), true)
    const parsed = JSON.parse(readFileSync(result!.approvalsPath, 'utf8')) as unknown
    assert.ok(Array.isArray(parsed))
    assert.ok((parsed as string[]).some((id) => id.startsWith('codeteam-manager-')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('materializeCursorMcpApprovals soft-fails on EPERM/EACCES instead of crashing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-eperm-'))
  const cursorHome = join(root, '.cursor')
  mkdirSync(cursorHome, { recursive: true })
  chmodSync(cursorHome, 0o500)
  try {
    const result = await materializeCursorMcpApprovals({
      cwd: join(root, 'workspace'),
      servers: [{ name: 'codeteam-manager', type: 'http', url: 'http://127.0.0.1:9/mcp' }],
      env: { HOME: root }
    })
    assert.equal(result, null)
  } finally {
    chmodSync(cursorHome, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
