import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '../..')

test('Electron package includes project notices and excludes dependency test noise', () => {
  const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  assert.match(config, /from:\s*LICENSE[\s\S]*to:\s*LICENSE/)
  assert.match(config, /from:\s*NOTICE[\s\S]*to:\s*NOTICE/)
  assert.match(
    config,
    /from:\s*THIRD_PARTY_DEPENDENCIES\.md[\s\S]*to:\s*THIRD_PARTY_DEPENDENCIES\.md/
  )
  assert.match(config, /node_modules\/\*\*\/\{test,tests,__tests__,example,examples\}/)
  assert.match(config, /node_modules\/\*\*\/\*\.map/)
  assert.match(config, /node_modules\/\*\*\/\*\.ts/)
  for (const language of ['en-US', 'zh-CN', 'zh_CN', 'ja']) {
    assert.match(config, new RegExp(`\\n\\s+- ${language}(?:\\n|$)`))
  }
})

test('Rust dependency policy is explicit', () => {
  const policy = readFileSync(join(root, 'deny.toml'), 'utf8')
  assert.match(policy, /\[advisories\]/)
  assert.match(policy, /yanked\s*=\s*"deny"/)
  assert.match(policy, /\[licenses\]/)
  assert.match(policy, /Apache-2\.0/)
})

test('reusable package builds enforce the committed package budgets', () => {
  const workflow = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8')
  assert.match(workflow, /npm run rebuild:electron/)
  assert.match(workflow, /check-package-budget\.mjs --dist dist/)
  assert.match(workflow, /package-budget\.log/)
})
