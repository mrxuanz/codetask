/**
 * Mixed CLI benchmark: ONE job, each task rotates through CLIs in order.
 *
 * Example rotation (default 4 CLIs, 7 tasks):
 *   m1-s1-t1 → Codex
 *   m2-s1-t1 → Claude Code
 *   m2-s2-t1 → OpenCode
 *   m3-s1-t1 → Cursor CLI
 *   m3-s2-t1 → Codex
 *   ...
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bootstrapRuntime } from '../src/server/bootstrap'
import type { SupportedCoreCode } from '../src/server/conversation/cores'
import {
  ALL_CORES,
  BLOG_TITLE,
  buildDraftPayload,
  buildMixedAbilities,
  clonePlanWithRotatingCores,
  describeTaskCoreAssignment,
  formatCoreRotation,
  launchPendingDesignSessions,
  launchSeededSession,
  loadTemplatePlan,
  randomDirName,
  readAuth,
  kickServerJobQueue,
  readCoresArg,
  resolveProjectDataDir,
  seedDesignSession,
  type SeededSession
} from './lib/seed-cli-benchmark-shared'

interface CliOptions {
  parentDir: string
  dryRun: boolean
  launchPending: boolean
  coreRotation: SupportedCoreCode[]
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((arg) => !arg.startsWith('--') && !arg.includes('='))
  const parentDir = positional[0]
  if (!parentDir?.trim() && !argv.includes('--launch-pending')) {
    throw new Error(
      'Usage: npm run seed:cli-benchmark:mixed -- <parentDir> [--cores codex,claude,open,cursor] [--dry-run] [--launch-pending]'
    )
  }

  return {
    parentDir: parentDir?.trim() ? resolve(parentDir) : '',
    dryRun: argv.includes('--dry-run'),
    launchPending: argv.includes('--launch-pending'),
    coreRotation: readCoresArg(argv) ?? [...ALL_CORES]
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  bootstrapRuntime({ dataDir: resolveProjectDataDir() })

  const auth = await readAuth()

  if (options.launchPending) {
    await launchPendingDesignSessions(auth.username)
    return
  }

  const templatePlan = loadTemplatePlan()
  const rotationLabel = formatCoreRotation(options.coreRotation)

  console.log(`Mode: mixed (任务级 CLI 轮换)`)
  console.log(`Parent directory: ${options.parentDir}`)
  console.log(`Rotation: ${rotationLabel}`)
  console.log(`User: ${auth.username}`)
  console.log(`Template plan: ${templatePlan.tasks.length} tasks\n`)

  mkdirSync(options.parentDir, { recursive: true })

  const folderName = randomDirName()
  const workspacePath = join(options.parentDir, folderName)
  mkdirSync(workspacePath, { recursive: true })

  console.log(`[混合 CLI] workspace: ${workspacePath}`)

  if (options.dryRun) {
    const previewPlan = clonePlanWithRotatingCores(
      templatePlan,
      options.coreRotation,
      workspacePath
    )
    console.log(`Task assignment: ${describeTaskCoreAssignment(previewPlan)}`)
    console.log('\n(dry-run, nothing written)')
    return
  }

  let result: SeededSession & { jobId?: string; jobStatus?: string; error?: string }

  try {
    const seeded = await seedDesignSession({
      username: auth.username,
      workspacePath,
      folderName,
      threadCoreCode: options.coreRotation[0]!,
      threadTitle: '混合 CLI benchmark',
      projectTitle: `${BLOG_TITLE} · 混合 CLI`,
      sessionCoreLabel: 'mixed',
      buildPlan: () =>
        clonePlanWithRotatingCores(templatePlan, options.coreRotation, workspacePath),
      buildDraftPayload: ({ draftMessageId, designSessionId }) =>
        buildDraftPayload({
          workspacePath,
          titleSuffix: '混合 CLI',
          draftMessageId,
          designSessionId,
          abilities: buildMixedAbilities(options.coreRotation),
          summaryExtra: `任务级 CLI 轮换：${rotationLabel}。`
        })
    })

    const launched = await launchSeededSession(
      auth.username,
      seeded.threadId,
      seeded.designSessionId
    )
    const plan = clonePlanWithRotatingCores(templatePlan, options.coreRotation, workspacePath)

    result = { ...seeded, jobId: launched.jobId, jobStatus: launched.status }
    console.log(`  → launched job ${launched.jobId} (${launched.status})`)
    console.log(`  → task assignment: ${describeTaskCoreAssignment(plan)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result = {
      coreCode: 'mixed',
      workspacePath,
      folderName,
      threadId: '',
      designSessionId: '',
      projectId: '',
      error: message
    }
    console.error(`  → failed: ${message}\n`)
  }

  console.log('--- Summary ---')
  if (result.error) {
    console.log(`混合 CLI: FAILED — ${result.error}`)
    process.exitCode = 1
    return
  }

  console.log(
    `混合 CLI (${rotationLabel}): ${result.folderName} → ${result.jobId ?? '(not launched)'} [${result.jobStatus ?? 'n/a'}]`
  )
  const kicked = await kickServerJobQueue(auth)
  console.log(
    kicked
      ? '\nJob is in the task list. The running server has been asked to advance the execution queue.'
      : '\nJob is in the task list (pending). Start or restart dev:serve to run it, or ensure the server is up and retry.'
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
