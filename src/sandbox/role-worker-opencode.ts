import { getAgentTurnProvider } from '../server/agent-runtime/providers'
import { runRoleWorker } from './role-worker-common'

/** OpenCode sandboxed worker — production route is Registry/OpenCodeDriver (PRU-09-08). */
runRoleWorker(getAgentTurnProvider('opencode'))
