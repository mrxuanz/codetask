import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const domainRoot = join(repoRoot, 'src/server/core/domain')

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /from\s+['"][^'"]*adapters\/providers[^'"]*['"]/,
  /from\s+['"][^'"]*server\/adapters\/providers[^'"]*['"]/,
  /from\s+['"]@openai\/codex-sdk['"]/,
  /from\s+['"]@anthropic-ai\/[^'"]+['"]/,
  /from\s+['"][^'"]*agent-runtime\/providers[^'"]*['"]/,
  /from\s+['"][^'"]*server\/providers\/[^'"]*['"]/,
  /import\s*\(\s*['"][^'"]*adapters\/providers[^'"]*['"]\s*\)/
]

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full))
      continue
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('provider adapter domain leak guard', () => {
  it('src/server/core/domain has no provider adapter / SDK imports', () => {
    assert.equal(statSync(domainRoot).isDirectory(), true)
    const files = listTsFiles(domainRoot)
    assert.ok(files.length > 0, 'expected domain source files')

    const violations: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${relative(repoRoot, file)} matches ${pattern}`)
        }
      }
    }

    assert.deepEqual(violations, [])
  })
})
