#!/usr/bin/env node

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REQUIRED_RELEASE_FILES = [
  '.github/workflows/build.yml',
  'package-lock.json',
  'scripts/package-server-sea.mjs',
  'scripts/release-evidence.mjs',
  'scripts/run-and-record.mjs'
]

function readArg(argv, name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

function git(repo, args, allowFailure = false) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (!allowFailure && result.status !== 0) {
    throw new Error(`release_source.git_failed:${args.join(':')}:${result.stderr.trim()}`)
  }
  return result
}

function fail(code, message) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.error(`::error title=Invalid release source::${message}`)
  }
  throw new Error(`release_source.${code}:${message}`)
}

export function resolveReleaseSource({ event, eventSha, tag, repo = resolve('.') }) {
  if (!['push', 'workflow_dispatch'].includes(event)) {
    fail('unsupported_event', event)
  }
  if (!/^v[0-9A-Za-z][0-9A-Za-z.+_-]*$/u.test(tag)) {
    fail('invalid_tag', `Expected a release tag beginning with "v", received "${tag}".`)
  }
  if (!/^[a-f0-9]{40}$/u.test(eventSha)) {
    fail('invalid_event_sha', eventSha)
  }

  const sourceSha = git(repo, ['rev-parse', `${eventSha}^{commit}`]).stdout.trim()
  const tagRef = `refs/tags/${tag}`
  const tagExists = git(repo, ['show-ref', '--verify', '--quiet', tagRef], true).status === 0
  if (tagExists) {
    const tagSha = git(repo, ['rev-parse', `${tagRef}^{commit}`]).stdout.trim()
    if (tagSha !== sourceSha) {
      fail(
        'tag_commit_mismatch',
        `Tag ${tag} points to ${tagSha}, but this workflow was dispatched from ${sourceSha}. ` +
          'Create a new release tag for the current commit; do not publish newer binaries under an older tag.'
      )
    }
  } else if (event === 'push') {
    fail('pushed_tag_missing', `${tag} is not available in the checkout.`)
  }

  for (const file of REQUIRED_RELEASE_FILES) {
    const exists = git(repo, ['cat-file', '-e', `${sourceSha}:${file}`], true).status === 0
    if (!exists) {
      fail(
        'tooling_missing',
        `Commit ${sourceSha} does not contain ${file}. Create a new tag from a release-capable commit.`
      )
    }
  }

  return { tag, version: tag.slice(1), sha: sourceSha, tagExists }
}

export function main(argv = process.argv.slice(2)) {
  const result = resolveReleaseSource({
    event: readArg(argv, '--event'),
    eventSha: readArg(argv, '--event-sha'),
    tag: readArg(argv, '--tag'),
    repo: resolve(readArg(argv, '--repo', '.'))
  })
  const output = readArg(argv, '--output', process.env.GITHUB_OUTPUT)
  if (output) {
    appendFileSync(
      output,
      `tag=${result.tag}\nversion=${result.version}\nsha=${result.sha}\ntag-exists=${result.tagExists}\n`
    )
  }
  console.log(JSON.stringify({ ok: true, ...result }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
