import { streamCodexTurn } from '../server/agent-runtime/providers/codex-sdk'
import { runRoleWorker } from './role-worker-common'

runRoleWorker({ code: 'codex', protocol: 'sdk', streamTurn: streamCodexTurn })
