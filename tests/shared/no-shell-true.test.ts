import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SCAN_ROOTS = [join(process.cwd(), 'src/server/providers')]

const FORBIDDEN_PATTERNS = [/shell:\s*true\b/, /shell:\s*process\.platform\b/]

function collectFiles(entry: string): string[] {
  const stat = statSync(entry)
  if (stat.isFile()) return [entry]
  const files: string[] = []
  for (const name of readdirSync(entry)) {
    if (name.endsWith('.ts')) {
      files.push(...collectFiles(join(entry, name)))
    }
  }
  return files
}

test('provider spawn paths do not use shell:true or shell: process.platform', () => {
  const offenders: Array<{ file: string; line: number; text: string }> = []

  for (const root of SCAN_ROOTS) {
    for (const file of collectFiles(root)) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? ''
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(text)) {
            offenders.push({ file, line: i + 1, text: text.trim() })
          }
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
