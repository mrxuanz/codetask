import { relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { ESLint } from 'eslint'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const maximumWarnings = 458

const knownErrors = [
  {
    id: 'BUSINESS-001',
    file: 'src/server/conversation/service.ts',
    ruleId: 'prefer-const',
    message: "'threadRow' is never reassigned. Use 'const' instead.",
    sourceLine: 'let threadRow = await getThreadRow(username, threadId)'
  }
]

function repositoryPath(filePath) {
  return relative(repositoryRoot, filePath).split(sep).join('/')
}

function issueKey(issue) {
  return [issue.file, issue.ruleId ?? '', issue.message, issue.sourceLine].join('\u0000')
}

function annotation(kind, issue, title) {
  const location = `file=${issue.file},line=${issue.line},col=${issue.column}`
  return `::${kind} ${location},title=${title}::${issue.message}`
}

const eslint = new ESLint({ cwd: repositoryRoot, cache: false })
const results = await eslint.lintFiles(['.'])
const warningCount = results.reduce((total, result) => total + result.warningCount, 0)
const actualErrors = results.flatMap((result) => {
  const sourceLines = result.source?.split(/\r?\n/u) ?? []
  return result.messages
    .filter((message) => message.severity === 2)
    .map((message) => ({
      file: repositoryPath(result.filePath),
      line: message.line,
      column: message.column,
      ruleId: message.ruleId,
      message: message.message,
      sourceLine: sourceLines[message.line - 1]?.trim() ?? ''
    }))
})

const knownByKey = new Map(knownErrors.map((issue) => [issueKey(issue), issue]))
const actualByKey = new Map(actualErrors.map((issue) => [issueKey(issue), issue]))
const unexpectedErrors = actualErrors.filter((issue) => !knownByKey.has(issueKey(issue)))
const staleAllowances = knownErrors.filter((issue) => !actualByKey.has(issueKey(issue)))

for (const issue of knownErrors) {
  const actual = actualByKey.get(issueKey(issue))
  if (actual) {
    console.log(annotation('warning', actual, `${issue.id} known business-code lint issue`))
  }
}

for (const issue of unexpectedErrors) {
  console.error(annotation('error', issue, 'Unexpected ESLint error'))
}

for (const issue of staleAllowances) {
  console.error(
    `Stale ESLint baseline ${issue.id}: ${issue.file} ${JSON.stringify(issue.sourceLine)} no longer matches`
  )
}

if (warningCount > maximumWarnings) {
  console.error(`ESLint warning count increased: ${warningCount} > ${maximumWarnings}`)
}

console.log(
  `ESLint baseline: ${actualErrors.length} known error(s), ${warningCount}/${maximumWarnings} warning(s)`
)

if (unexpectedErrors.length > 0 || staleAllowances.length > 0 || warningCount > maximumWarnings) {
  process.exitCode = 1
}
