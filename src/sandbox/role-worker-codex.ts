import { getAgentTurnProvider } from '../server/agent-runtime/providers'
import { runRoleWorker } from './role-worker-common'

/** Codex sandboxed worker — production route is Registry/CodexDriver (PRU-07-08). */
runRoleWorker(getAgentTurnProvider('codex'))
