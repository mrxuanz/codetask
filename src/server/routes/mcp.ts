import { Hono } from 'hono'
import type { AppContext } from '../context'
import { streamSSE } from 'hono/streaming'
import { handleConversationMcpJsonRpc, type McpDispatchResult } from '../conversation/mcp/handler'
import { authorizeConversationMcpRequest } from '../conversation/mcp/session'
import { requireLocalhost } from '../middleware/local-only'
import { AppError } from '../error'
import {
  closeAllStreamableMcpTransportsForUrlSession,
  closeStreamableMcpTransport,
  dispatchStreamableMcpPost,
  streamMcpSseEvents
} from '../mcp/streamable-http'

function mcpForbidden(message: string): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message }
    },
    { status: 403 }
  )
}

function executionMcpGone(): McpDispatchResult {
  return {
    kind: 'json',
    body: {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32000,
        message:
          'Execution MCP moved to AgentRuntime binding; HTTP task/slice/milestone MCP endpoints are retired.'
      }
    }
  }
}

async function readJsonBody(c: {
  req: { text: () => Promise<string> }
}): Promise<unknown | Response> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: request body is not valid JSON' }
      },
      { status: 400 }
    )
  }
}

type AuthorizeFn = (input: {
  sessionId: string
  query: Record<string, string | undefined>
}) => boolean

type HandleFn = (sessionId: string, body: unknown) => Promise<McpDispatchResult>

function registerStreamableMcpRoute(
  mcp: Hono,
  path: string,
  authorize: AuthorizeFn,
  handle: HandleFn
): void {
  mcp.post(path, async (c) => {
    const sessionId = c.req.param('sessionId') ?? ''
    if (!sessionId) {
      return Response.json({ error: 'sessionId required' }, { status: 400 })
    }
    const query = c.req.query()
    if (!authorize({ sessionId, query })) {
      return mcpForbidden(`${path} MCP capability check failed`)
    }

    const body = await readJsonBody(c)
    if (body instanceof Response) return body

    const mcpSessionId = c.req.header('Mcp-Session-Id')?.trim() || null
    const dispatched = await dispatchStreamableMcpPost({
      urlSessionId: sessionId,
      mcpSessionId,
      acceptHeader: c.req.header('Accept') ?? undefined,
      body,
      handle
    })

    if (!dispatched.body) {
      return new Response(null, { status: dispatched.status })
    }

    return Response.json(dispatched.body, {
      status: dispatched.status,
      headers: {
        'Content-Type': dispatched.contentType,
        ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {})
      }
    })
  })

  mcp.get(path, async (c) => {
    const sessionId = c.req.param('sessionId') ?? ''
    if (!sessionId) {
      return Response.json({ error: 'sessionId required' }, { status: 400 })
    }
    const query = c.req.query()
    if (!authorize({ sessionId, query })) {
      return mcpForbidden(`${path} MCP capability check failed`)
    }

    const accept = c.req.header('Accept') ?? ''
    if (!accept.includes('text/event-stream')) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: 'Streamable HTTP requires Accept: text/event-stream on GET'
          }
        },
        { status: 406 }
      )
    }

    const mcpSessionId = c.req.header('Mcp-Session-Id')?.trim() || null
    const lastEventId = c.req.header('Last-Event-ID')

    return streamSSE(c, async (stream) => {
      for await (const event of streamMcpSseEvents({
        urlSessionId: sessionId,
        mcpSessionId,
        lastEventIdHeader: lastEventId
      })) {
        await stream.writeSSE({
          event: event.event,
          id: event.id,
          data: event.data
        })
      }
    })
  })

  mcp.delete(path, async (c) => {
    const sessionId = c.req.param('sessionId') ?? ''
    if (!sessionId) {
      return Response.json({ error: 'sessionId required' }, { status: 400 })
    }
    const query = c.req.query()
    if (!authorize({ sessionId, query })) {
      return mcpForbidden(`${path} MCP capability check failed`)
    }

    const mcpSessionId = c.req.header('Mcp-Session-Id')?.trim() || null
    if (mcpSessionId) {
      closeStreamableMcpTransport(sessionId, mcpSessionId)
    } else {
      closeAllStreamableMcpTransportsForUrlSession(sessionId)
    }
    return new Response(null, { status: 204 })
  })
}

function registerExecutionMcpGoneRoute(mcp: Hono, path: string): void {
  // HTTP task/slice/milestone MCP is retired; AgentRuntime binds MCP in-process.
  // FakeAgentRuntime completes work without HTTP MCP during integration tests.
  mcp.all(path, () => {
    throw AppError.gone(
      'Execution MCP is bound via AgentRuntime; HTTP task/slice/milestone MCP endpoints are retired.',
      'execution.mcp_moved'
    )
  })
}

function registerPlannerMcpGoneRoute(mcp: Hono, path: string): void {
  // Legacy thread_job Planner HTTP MCP never registers sessions after Design cutover.
  // Planning commits via PlanningApplicationPort / SnapshotPlannerRunner.
  mcp.all(path, () => {
    throw AppError.gone(
      'Planner HTTP MCP is retired; Design planning commits through PlanningApplicationPort.',
      'planner.mcp_moved'
    )
  })
}

export function createMcpRoutes(_ctx: AppContext): Hono {
  const mcp = new Hono()

  mcp.use('*', requireLocalhost)

  registerStreamableMcpRoute(
    mcp,
    '/conversation/:sessionId',
    ({ sessionId, query }) =>
      authorizeConversationMcpRequest({
        sessionId,
        role: query.role,
        threadId: query.threadId,
        capability: query.cap
      }),
    handleConversationMcpJsonRpc
  )

  registerExecutionMcpGoneRoute(mcp, '/task/:sessionId')
  registerExecutionMcpGoneRoute(mcp, '/task/:sessionId/*')
  registerExecutionMcpGoneRoute(mcp, '/slice-verifier/:sessionId')
  registerExecutionMcpGoneRoute(mcp, '/slice-verifier/:sessionId/*')
  registerExecutionMcpGoneRoute(mcp, '/milestone-verifier/:sessionId')
  registerExecutionMcpGoneRoute(mcp, '/milestone-verifier/:sessionId/*')

  registerPlannerMcpGoneRoute(mcp, '/planner/:sessionId')
  registerPlannerMcpGoneRoute(mcp, '/planner/:sessionId/*')

  return mcp
}

export { executionMcpGone }
