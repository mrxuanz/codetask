import { streamClaudeTurn } from '../server/agent-runtime/providers/claude-sdk'
import { runRoleWorker } from './role-worker-common'

runRoleWorker({ code: 'claude-code', protocol: 'sdk', streamTurn: streamClaudeTurn })
