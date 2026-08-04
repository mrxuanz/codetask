import { Hono } from 'hono'
import { Value } from '@sinclair/typebox/value'
import {
  ConfirmDraftBodySchema,
  ConfirmTreeNodeBodySchema,
  CreateDraftBodySchema,
  CreatePlanningSessionBodySchema,
  PatchAbilitiesBodySchema,
  PatchDraftBodySchema,
  PatchExecutionProfileBodySchema,
  PatchTreeNodeBodySchema,
  PublishPlanningBodySchema,
  UnlockDraftBodySchema
} from '@codetask/contracts'
import type { DraftApplication } from '../application/draft-application.ts'
import type { PlanningApplication } from '../../planning/application/planning-application.ts'
import type { Actor } from '../../shared.ts'
import {
  DesignConflictError,
  DesignForbiddenError,
  DesignNotFoundError,
  DesignValidationError
} from '../../shared.ts'

export type DesignHttpEnv = {
  Variables: {
    actor: Actor
    requestId: string
  }
}

function ok<T>(
  data: T,
  requestId: string
): {
  success: true
  data: T
  requestId: string
} {
  return { success: true as const, data, requestId }
}

function fail(
  code: string,
  message: string,
  status: number,
  requestId: string
): {
  body: {
    success: false
    error: { code: string; message: string }
    requestId: string
  }
  status: number
} {
  return {
    body: {
      success: false as const,
      error: { code, message },
      requestId
    },
    status
  }
}

function mapError(
  error: unknown,
  requestId: string
): { body: ReturnType<typeof fail>['body']; status: number } {
  if (error instanceof DesignConflictError) {
    return fail(error.code, error.message, 409, requestId)
  }
  if (error instanceof DesignValidationError) {
    return fail(error.code, error.message, 400, requestId)
  }
  if (error instanceof DesignNotFoundError) {
    return fail(error.code, error.message, 404, requestId)
  }
  if (error instanceof DesignForbiddenError) {
    return fail(error.code, error.message, 403, requestId)
  }
  return fail(
    'design.internal',
    error instanceof Error ? error.message : String(error),
    500,
    requestId
  )
}

function requireActor(c: { get: (k: 'actor') => Actor | undefined; var?: unknown }): Actor {
  const actor = c.get('actor')
  if (!actor) throw new DesignForbiddenError('Missing actor')
  return actor
}

export function createDraftRoutes(
  drafts: DraftApplication,
  planning: PlanningApplication
): Hono<DesignHttpEnv> {
  const app = new Hono<DesignHttpEnv>()

  app.get('/', async (c) => {
    try {
      const actor = requireActor(c)
      const q = c.req.query('q') ?? undefined
      const completion =
        (c.req.query('completion') as 'all' | 'incomplete' | 'complete' | undefined) ?? 'all'
      const data = await drafts.list(actor, { q, completion })
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/', async (c) => {
    try {
      const actor = requireActor(c)
      const body = await c.req.json()
      if (!Value.Check(CreateDraftBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid create draft body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.create(actor, body)
      return c.json(ok(data, c.get('requestId')), 201)
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.get('/:draftId', async (c) => {
    try {
      const data = await drafts.get(requireActor(c), c.req.param('draftId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.patch('/:draftId', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(PatchDraftBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid patch body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.patch(requireActor(c), c.req.param('draftId'), body)
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.delete('/:draftId', async (c) => {
    try {
      await drafts.archive(requireActor(c), c.req.param('draftId'))
      return c.json(ok({ archived: true }, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:draftId/confirm', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(ConfirmDraftBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid confirm body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.confirm(
        requireActor(c),
        c.req.param('draftId'),
        body.expectedRevision
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:draftId/unlock', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(UnlockDraftBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid unlock body', 400, c.get('requestId')).body,
          400
        )
      }
      if (body.cancelActivePlanning) {
        // Active sessions must be cancelled explicitly via planning API; unlock enforces zero active.
      }
      const data = await drafts.unlock(
        requireActor(c),
        c.req.param('draftId'),
        body.expectedRevision
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:draftId/sections/:section/confirm', async (c) => {
    try {
      const body = await c.req.json()
      const expectedRevision =
        typeof body?.expectedRevision === 'number' ? body.expectedRevision : -1
      if (expectedRevision < 0) {
        return c.json(
          fail('design.validation', 'expectedRevision required', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.confirmSection(
        requireActor(c),
        c.req.param('draftId'),
        c.req.param('section'),
        expectedRevision
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.patch('/:draftId/abilities', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(PatchAbilitiesBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid abilities body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.patchAbilities(
        requireActor(c),
        c.req.param('draftId'),
        body.expectedRevision,
        body.abilities
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.patch('/:draftId/execution-profile', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(PatchExecutionProfileBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid execution profile body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.patchExecutionProfile(
        requireActor(c),
        c.req.param('draftId'),
        body.expectedRevision,
        body.executionProfile
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.get('/:draftId/references', async (c) => {
    try {
      const data = await drafts.listReferences(requireActor(c), c.req.param('draftId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:draftId/references', async (c) => {
    try {
      const body = await c.req.json()
      const expectedRevision =
        typeof body?.expectedRevision === 'number' ? body.expectedRevision : -1
      if (expectedRevision < 0 || !body?.name || !body?.kind || !body?.description) {
        return c.json(
          fail('design.validation', 'Invalid reference body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.addReference(
        requireActor(c),
        c.req.param('draftId'),
        {
          name: String(body.name),
          kind: body.kind,
          description: String(body.description),
          source: body.source,
          mimeType: body.mimeType,
          attachmentId: body.attachmentId,
          localPath: body.localPath,
          resolvedPath: body.resolvedPath,
          assetUrl: body.assetUrl
        },
        expectedRevision
      )
      return c.json(ok(data, c.get('requestId')), 201)
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.patch('/:draftId/references/:referenceId', async (c) => {
    try {
      const body = await c.req.json()
      const expectedRevision =
        typeof body?.expectedRevision === 'number' ? body.expectedRevision : -1
      if (expectedRevision < 0) {
        return c.json(
          fail('design.validation', 'expectedRevision required', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.patchReference(
        requireActor(c),
        c.req.param('draftId'),
        c.req.param('referenceId'),
        { name: body.name, description: body.description },
        expectedRevision
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.delete('/:draftId/references/:referenceId', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const expectedRevision =
        typeof body?.expectedRevision === 'number' ? body.expectedRevision : -1
      if (expectedRevision < 0) {
        return c.json(
          fail('design.validation', 'expectedRevision required', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await drafts.deleteReference(
        requireActor(c),
        c.req.param('draftId'),
        c.req.param('referenceId'),
        expectedRevision
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:draftId/planning-session', async (c) => {
    try {
      const actor = requireActor(c)
      const body = await c.req.json()
      if (!Value.Check(CreatePlanningSessionBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid planning session body', 400, c.get('requestId')).body,
          400
        )
      }
      const draft = await drafts.get(actor, c.req.param('draftId'))
      if (draft.lockRevision !== body.expectedRevision) {
        return c.json(
          fail('design.conflict', 'Revision conflict', 409, c.get('requestId')).body,
          409
        )
      }
      const snapshot = await drafts.captureConfirmedSnapshot(actor, draft.id)
      const session = await planning.createSession({
        actor,
        draftSnapshot: snapshot,
        references: draft.references
      })
      return c.json(ok(session, c.get('requestId')), 201)
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.get('/:draftId/planning-sessions', async (c) => {
    try {
      const actor = requireActor(c)
      await drafts.get(actor, c.req.param('draftId'))
      const sessions = await planning.listForDraft(actor, c.req.param('draftId'))
      return c.json(ok(sessions, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  return app
}

export function createPlanningRoutes(planning: PlanningApplication): Hono<DesignHttpEnv> {
  const app = new Hono<DesignHttpEnv>()

  app.get('/:sessionId', async (c) => {
    try {
      const data = await planning.get(requireActor(c), c.req.param('sessionId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:sessionId/retry', async (c) => {
    try {
      const data = await planning.retry(requireActor(c), c.req.param('sessionId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:sessionId/cancel', async (c) => {
    try {
      const data = await planning.cancel(requireActor(c), c.req.param('sessionId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:sessionId/regenerate', async (c) => {
    try {
      const data = await planning.regenerate(requireActor(c), c.req.param('sessionId'))
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.patch('/:sessionId/tree/nodes/:nodeId', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(PatchTreeNodeBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid tree patch body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await planning.patchNode(
        requireActor(c),
        c.req.param('sessionId'),
        c.req.param('nodeId'),
        body
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:sessionId/tree/nodes/:nodeId/confirm', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(ConfirmTreeNodeBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid confirm node body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await planning.confirmNode(
        requireActor(c),
        c.req.param('sessionId'),
        c.req.param('nodeId'),
        body.expectedRevision
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  app.post('/:sessionId/publish', async (c) => {
    try {
      const body = await c.req.json()
      if (!Value.Check(PublishPlanningBodySchema, body)) {
        return c.json(
          fail('design.validation', 'Invalid publish body', 400, c.get('requestId')).body,
          400
        )
      }
      const data = await planning.publish(
        requireActor(c),
        c.req.param('sessionId'),
        body.expectedRevision,
        body.idempotencyKey
      )
      return c.json(ok(data, c.get('requestId')))
    } catch (error) {
      const mapped = mapError(error, c.get('requestId'))
      return c.json(mapped.body, mapped.status as 400)
    }
  })

  return app
}
