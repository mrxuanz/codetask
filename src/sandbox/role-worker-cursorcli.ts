import { getAgentTurnProvider } from '../server/agent-runtime/providers'
import { runRoleWorker } from './role-worker-common'

/** Cursor sandboxed worker — production route is Registry/CursorDriver (PRU-10-08). */
runRoleWorker(getAgentTurnProvider('cursorcli'))
