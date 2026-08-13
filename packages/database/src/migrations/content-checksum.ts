import { createHash } from 'node:crypto'

export function normalizeMigrationSource(source: string): string {
  return `${source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()}\n`
}

export function migrationSourceChecksum(source: string): string {
  return createHash('sha256').update(normalizeMigrationSource(source), 'utf8').digest('hex')
}
