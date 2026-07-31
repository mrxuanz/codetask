import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveCursorWorkspaceProjectSlug,
  slugifyCursorProjectPath
} from '../../src/server/agent-runtime/cursor-acp/cursor-workspace'

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
  assert.equal(resolveCursorWorkspaceProjectSlug(workspace), 'tmp-codetask-cursor-slug-fixture-my-project')
})
