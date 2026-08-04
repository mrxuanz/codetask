#!/usr/bin/env node
/**
 * Stamp the invoking Node binary into CODETASK_HOST_NODE so the Electron shell
 * can spawn the Hono Service on system Node (Node ABI), not Electron-as-Node.
 */
import { spawnSync } from 'node:child_process'

process.env.CODETASK_HOST_NODE = process.execPath

const [, , command, ...args] = process.argv
if (!command) {
  process.exit(0)
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: true,
  env: process.env
})
process.exit(result.status ?? 1)
