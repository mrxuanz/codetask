import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TSX_TSCONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tsconfig.node.json'
)
