/**
 * Uniform CLI benchmark: one job per CLI, entire execution tree uses the same CLI.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bootstrapRuntime } from '../src/server/bootstrap'
import type { SupportedCoreCode } from '../src/server/conversation/cores'
import {
  ALL_CORES,
  BLOG_TITLE,
  buildAbilities,
  buildDraftPayload,
  clonePlanForUniformCore,
  formatCoreLabel,
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
  cores: SupportedCoreCode[]
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((arg) => !arg.startsWith('--') && !arg.includes('='))
  const parentDir = positional[0]
  if (!parentDir?.trim() && !argv.includes('--launch-pending')) {
    throw new Error(
      'Usage: npm run seed:cli-benchmark -- <parentDir> [--cores codex,claude,open,cursor] [--dry-run] [--launch-pending]'
    )
  }

  return {
    parentDir: parentDir?.trim() ? resolve(parentDir) : '',
    dryRun: argv.includes('--dry-run'),
    launchPending: argv.includes('--launch-pending'),
    cores: readCoresArg(argv) ?? [...ALL_CORES]
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

  console.log(`Mode: uniform (整树同一 CLI)`)
  console.log(`Parent directory: ${options.parentDir}`)
  console.log(`CLIs: ${options.cores.map((c) => formatCoreLabel(c)).join(', ')}`)
  console.log(`User: ${auth.username}`)
  console.log(`Template plan: ${templatePlan.tasks.length} tasks\n`)

  mkdirSync(options.parentDir, { recursive: true })

  const usedNames = new Set<string>()
  const results: Array<SeededSession & { jobId?: string; jobStatus?: string; error?: string }> = []

  for (const coreCode of options.cores) {
    let folderName = randomDirName()
    while (usedNames.has(folderName)) {
      folderName = randomDirName()
    }
    usedNames.add(folderName)

    const workspacePath = join(options.parentDir, folderName)
    mkdirSync(workspacePath, { recursive: true })

    console.log(`[${formatCoreLabel(coreCode)}] workspace: ${workspacePath}`)

    if (options.dryRun) {
      results.push({
        coreCode,
        workspacePath,
        folderName,
        threadId: '(dry-run)',
        designSessionId: '(dry-run)',
        projectId: '(dry-run)'
      })
      continue
    }

    try {
      const seeded = await seedDesignSession({
        username: auth.username,
        workspacePath,
        folderName,
        threadCoreCode: coreCode,
        threadTitle: `${formatCoreLabel(coreCode)} benchmark`,
        projectTitle: `${BLOG_TITLE} · ${formatCoreLabel(coreCode)}`,
        sessionCoreLabel: coreCode,
        buildPlan: () => clonePlanForUniformCore(templatePlan, coreCode, workspacePath),
        buildDraftPayload: ({ draftMessageId, designSessionId }) =>
          buildDraftPayload({
            workspacePath,
            titleSuffix: formatCoreLabel(coreCode),
            draftMessageId,
            designSessionId,
            abilities: buildAbilities(coreCode, 'CLI benchmark: 整树统一')
          })
      })

      const launched = await launchSeededSession(
        auth.username,
        seeded.threadId,
        seeded.designSessionId
      )
      results.push({ ...seeded, jobId: launched.jobId, jobStatus: launched.status })
      console.log(`  → launched job ${launched.jobId} (${launched.status})\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({
        coreCode,
        workspacePath,
        folderName,
        threadId: '',
        designSessionId: '',
        projectId: '',
        error: message
      })
      console.error(`  → failed: ${message}\n`)
    }
  }

  console.log('--- Summary ---')
  for (const row of results) {
    if (row.error) {
      console.log(`${formatCoreLabel(row.coreCode as SupportedCoreCode)}: FAILED — ${row.error}`)
      continue
    }
    console.log(
      `${formatCoreLabel(row.coreCode as SupportedCoreCode)}: ${row.folderName} → ${row.jobId ?? '(not launched)'} [${row.jobStatus ?? 'n/a'}]`
    )
  }

  const failures = results.filter((row) => row.error)
  if (failures.length > 0) {
    process.exitCode = 1
  } else {
    const kicked = await kickServerJobQueue(auth)
    console.log(
      kicked
        ? '\nJobs are in the task list. The running server has been asked to advance the execution queue.'
        : '\nJobs are in the task list (pending). Start or restart dev:serve to run them, or ensure the server is up and retry.'
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
