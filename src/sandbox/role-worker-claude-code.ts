import { getAgentTurnProvider } from '../server/agent-runtime/providers'
import { runRoleWorker } from './role-worker-common'

/** Claude sandboxed worker — production route is Registry/ClaudeDriver (PRU-08-08). */
runRoleWorker(getAgentTurnProvider('claude-code'))
