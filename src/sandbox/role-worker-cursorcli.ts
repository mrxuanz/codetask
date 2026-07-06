import { streamCursorAcpTurn } from '../server/agent-runtime/providers/cursor-acp'
import { runRoleWorker } from './role-worker-common'

runRoleWorker({ code: 'cursorcli', protocol: 'acp', streamTurn: streamCursorAcpTurn })
