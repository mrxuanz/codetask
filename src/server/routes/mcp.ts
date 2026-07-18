import { Hono } from 'hono'
import type { AppContext } from '../context'
import { streamSSE } from 'hono/streaming'
import { handleConversationMcpJsonRpc, type McpDispatchResult } from '../conversation/mcp/handler'
import { authorizeConversationMcpRequest } from '../conversation/mcp/session'
import { handlePlannerMcpJsonRpc } from '../planner/mcp/handler'
import { authorizePlannerMcpRequest } from '../planner/mcp/session'
import { handleTaskMcpJsonRpc } from '../legacy-control-plane/mcp/task-handler'
import { authorizeTaskMcpRequest } from '../legacy-control-plane/mcp/task-session'
import { handleSliceVerifierMcpJsonRpc } from '../legacy-control-plane/mcp/slice-handler'
import { authorizeSliceVerifierMcpRequest } from '../legacy-control-plane/mcp/slice-session'
import { handleMilestoneVerifierMcpJsonRpc } from '../legacy-control-plane/mcp/milestone-handler'
import { authorizeMilestoneVerifierMcpRequest } from '../legacy-control-plane/mcp/milestone-session'
import { requireLocalhost } from '../middleware/local-only'
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
        wizardStage: query.wizardStage,
        threadId: query.threadId,
        capability: query.cap
      }),
    handleConversationMcpJsonRpc
  )

  registerStreamableMcpRoute(
    mcp,
    '/task/:sessionId',
    ({ sessionId, query }) =>
      authorizeTaskMcpRequest({
        sessionId,
        role: query.role,
        jobId: query.jobId,
        taskId: query.taskId,
        idempotencyKey: query.idem,
        capability: query.cap
      }),
    handleTaskMcpJsonRpc
  )

  registerStreamableMcpRoute(
    mcp,
    '/slice-verifier/:sessionId',
    ({ sessionId, query }) =>
      authorizeSliceVerifierMcpRequest({
        sessionId,
        role: query.role,
        jobId: query.jobId,
        sliceId: query.sliceId,
        capability: query.cap
      }),
    handleSliceVerifierMcpJsonRpc
  )

  registerStreamableMcpRoute(
    mcp,
    '/milestone-verifier/:sessionId',
    ({ sessionId, query }) =>
      authorizeMilestoneVerifierMcpRequest({
        sessionId,
        role: query.role,
        jobId: query.jobId,
        milestoneId: query.milestoneId,
        capability: query.cap
      }),
    handleMilestoneVerifierMcpJsonRpc
  )

  registerStreamableMcpRoute(
    mcp,
    '/planner/:sessionId',
    ({ sessionId, query }) =>
      authorizePlannerMcpRequest({
        sessionId,
        role: query.role,
        jobId: query.jobId,
        capability: query.cap
      }),
    handlePlannerMcpJsonRpc
  )

  return mcp
}
