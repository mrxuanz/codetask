import { streamOpencodeTurn } from '../server/agent-runtime/providers/opencode-sdk'
import { runRoleWorker } from './role-worker-common'

runRoleWorker({ code: 'opencode', protocol: 'sdk', streamTurn: streamOpencodeTurn })
