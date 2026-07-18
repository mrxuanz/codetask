import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ignoredDirectoryNames = new Set(['.git', 'dist', 'node_modules', 'out'])
const maximumFileSize = 1_000_000

function normalizePath(filePath) {
  return filePath.split(sep).join('/')
}

function listFiles(repositoryRoot, scanPath) {
  const absolutePath = join(repositoryRoot, scanPath)
  if (!existsSync(absolutePath)) return []

  const stats = statSync(absolutePath)
  if (stats.isFile()) return [normalizePath(relative(repositoryRoot, absolutePath))]
  if (!stats.isDirectory()) return []

  const files = []
  const entries = readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )

  for (const entry of entries) {
    if (entry.name.startsWith('.') || ignoredDirectoryNames.has(entry.name)) continue

    const relativePath = join(scanPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(repositoryRoot, relativePath))
      continue
    }
    if (entry.isFile()) {
      files.push(normalizePath(relativePath))
    }
  }

  return files
}

export function scanSourcePatterns({ repositoryRoot, scanPaths, patterns }) {
  const matcher = new RegExp(patterns.map((pattern) => `(?:${pattern})`).join('|'))
  const matches = []

  for (const scanPath of scanPaths) {
    for (const filePath of listFiles(repositoryRoot, scanPath)) {
      const absolutePath = join(repositoryRoot, filePath)
      if (statSync(absolutePath).size > maximumFileSize) continue

      const source = readFileSync(absolutePath, 'utf8')
      if (source.includes('\u0000')) continue

      const lines = source.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher.test(lines[index])) continue
        matches.push({
          file: filePath,
          line: index + 1,
          text: lines[index]
        })
      }
    }
  }

  return matches
}
