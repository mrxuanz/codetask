import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono, type Context, type Next } from 'hono'
import { Type, type Static } from '@sinclair/typebox'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { SETUP_TOKEN_HEADER } from '@codetask/contracts'
import { serveStatic } from '@hono/node-server/serve-static'
import { proxy } from 'hono/proxy'
import { createFolderBrowserRoutes } from '../../../src/server/routes/fs'
import { shouldServeSpaIndex } from '../../../src/server/http/spa-fallback'
import { fail, ok } from '../../../src/server/response'
import { toErrorHttpResult } from '../../../src/server/error'
import { bodySizeLimit } from '../../../src/server/middleware/body-limiter'
import { requestTimeout } from '../../../src/server/middleware/http-limits'
import { parseJsonBody } from '../../../src/server/http/json-body'
import type { DataDirResolution } from '@codetask/service-bootstrap/storage-selection'
import { initializeStorageRoot } from './storage-initializer'
import {
  StorageValidationNonceRepository,
  validateExistingStorageRoot,
  validateStorageTarget
} from './storage-validation'

const ValidateStorageBodySchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    allowLowSpace: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
)
const InitializeStorageBodySchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    validationNonce: Type.Optional(Type.String()),
    allowLowSpace: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
)
const RecoverStorageBodySchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    validationNonce: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)

export interface SetupShellOptions {
  storage: DataDirResolution
  isDev: boolean
  rendererDevUrl?: string
  staticDir?: string
  forbiddenRoots?: readonly string[]
  /** Server mode requires a console setup token; desktop does not. */
  setupTokenRequired?: boolean
  /** Validate the console token while the durable auth database does not exist. */
  validateSetupToken?: (token: string) => boolean
  /** Persist the selected root to codetask-data.json before activating the full runtime. */
  persistDataDir?: (dataDir: string) => void | Promise<void>
  /** Boot the full runtime in-process after storage is ready (no process restart). */
  activateStorage?: (dataDir: string) => void | Promise<void>
}

export function createSetupShell(options: SetupShellOptions): Hono {
  const app = new Hono()
  const initializationNonces = new StorageValidationNonceRepository()
  const recoveryNonces = new StorageValidationNonceRepository()
  const requestId = (c: Context): string =>
    (c.get('requestId' as never) as string | undefined) ?? 'unknown'

  app.use('/api/*', async (c, next) => {
    c.set('requestId' as never, crypto.randomUUID())
    await next()
  })
  app.use('/api/*', requestTimeout())
  app.use('/api/*', bodySizeLimit())

  const requireSetupToken = async (c: Context, next: Next): Promise<Response | void> => {
    if (!options.setupTokenRequired) {
      await next()
      return
    }
    const token = c.req.header(SETUP_TOKEN_HEADER)?.trim() ?? ''
    if (!token || !options.validateSetupToken?.(token)) {
      return c.json(
        fail('auth.invalid_setup_token', 'Invalid or expired setup token', {}, requestId(c)),
        401
      )
    }
    await next()
  }

  app.use('/api/fs/*', requireSetupToken)
  app.use('/api/system/storage/bootstrap', requireSetupToken)
  app.use('/api/system/storage/validate', requireSetupToken)
  app.use('/api/system/storage/initialize', requireSetupToken)
  app.use('/api/system/storage/recover', requireSetupToken)

  app.onError((error, c) => {
    const id = requestId(c)
    console.error('[setup] unhandled HTTP error', { requestId: id, error })
    const { body, status } = toErrorHttpResult(error, id)
    return c.json(body, status as ContentfulStatusCode)
  })

  app.get('/api/health', (c) => c.json(ok({ status: 'ok', phase: 'storage_setup' }, requestId(c))))
  app.get('/api/auth/bootstrap', (c) =>
    c.json(
      ok(
        {
          initialized: false,
          authenticated: false,
          setupTokenRequired: options.setupTokenRequired === true,
          storagePhase: options.storage.phase
        },
        requestId(c)
      )
    )
  )
  app.get('/api/system/storage/bootstrap', (c) => {
    return c.json(
      ok(
        {
          phase: options.storage.phase,
          defaultCandidate: options.storage.dataDir,
          source: options.storage.source === 'candidate' ? 'none' : options.storage.source,
          issue: options.storage.issue
        },
        requestId(c)
      )
    )
  })

  // Shared module; the host protects it with the process setup gate in server mode.
  app.route('/api/fs', createFolderBrowserRoutes())

  app.post('/api/system/storage/validate', async (c) => {
    const body = await parseJsonBody<Static<typeof ValidateStorageBodySchema>>(
      c,
      ValidateStorageBodySchema,
      'Invalid storage validation body'
    )
    const forbiddenRoots = options.forbiddenRoots ?? []
    const path = body.path ?? ''
    const allowLowSpace = body.allowLowSpace === true

    // A missing locator does not mean the selected directory is new. Both first-run selection
    // and recovery may safely adopt a marked CodeTask root after SQLite integrity validation.
    const existing = validateExistingStorageRoot({
      path,
      forbiddenRoots,
      nonceRepository: recoveryNonces
    })
    if (existing.ok) {
      return c.json(ok({ ...existing, action: 'recover' as const }, requestId(c)))
    }

    const fresh = validateStorageTarget({
      path,
      forbiddenRoots,
      allowLowSpace,
      nonceRepository: initializationNonces
    })
    if (!fresh.ok) {
      return c.json(
        fail(
          400,
          fresh.issue ?? existing.issue ?? 'storage_target_invalid',
          { ...fresh },
          requestId(c)
        ),
        400
      )
    }
    return c.json(ok({ ...fresh, action: 'initialize' as const }, requestId(c)))
  })

  app.post('/api/system/storage/initialize', async (c) => {
    if (options.storage.phase !== 'selection_required') {
      return c.json(fail(409, 'storage_initialization_not_allowed', {}, requestId(c)), 409)
    }
    const body = await parseJsonBody<Static<typeof InitializeStorageBodySchema>>(
      c,
      InitializeStorageBodySchema,
      'Invalid storage initialization body'
    )
    const validation = validateStorageTarget({
      path: body.path ?? '',
      forbiddenRoots: options.forbiddenRoots,
      allowLowSpace: body.allowLowSpace === true
    })
    if (!validation.ok) {
      return c.json(
        fail(400, validation.issue ?? 'storage_target_invalid', { ...validation }, requestId(c)),
        400
      )
    }
    if (
      !body.validationNonce ||
      !initializationNonces.consume(body.validationNonce, validation.canonicalPath)
    ) {
      return c.json(
        fail(
          409,
          'storage_validation_expired',
          { issue: 'storage_validation_expired' },
          requestId(c)
        ),
        409
      )
    }

    try {
      const initialized = initializeStorageRoot({
        dataDir: validation.canonicalPath
      })
      if (options.persistDataDir) {
        await options.persistDataDir(initialized.dataDir)
      }
      if (options.activateStorage) {
        await options.activateStorage(initialized.dataDir)
      }
      return c.json(ok({ phase: 'ready', dataDir: initialized.dataDir }, requestId(c)))
    } catch (error) {
      console.error('[setup] storage initialization failed', { requestId: requestId(c), error })
      return c.json(fail(500, 'storage_initialize_failed', {}, requestId(c)), 500)
    }
  })

  app.post('/api/system/storage/recover', async (c) => {
    if (options.storage.phase !== 'selection_required') {
      return c.json(fail(409, 'storage_recovery_not_allowed', {}, requestId(c)), 409)
    }
    const body = await parseJsonBody<Static<typeof RecoverStorageBodySchema>>(
      c,
      RecoverStorageBodySchema,
      'Invalid storage recovery body'
    )
    const validation = validateExistingStorageRoot({
      path: body.path ?? '',
      forbiddenRoots: options.forbiddenRoots
    })
    if (!validation.ok) {
      return c.json(
        fail(400, validation.issue ?? 'storage_target_invalid', { ...validation }, requestId(c)),
        400
      )
    }
    if (
      !body.validationNonce ||
      !recoveryNonces.consume(body.validationNonce, validation.canonicalPath)
    ) {
      return c.json(
        fail(
          409,
          'storage_validation_expired',
          { issue: 'storage_validation_expired' },
          requestId(c)
        ),
        409
      )
    }

    try {
      if (options.persistDataDir) {
        await options.persistDataDir(validation.canonicalPath)
      }
      if (options.activateStorage) {
        await options.activateStorage(validation.canonicalPath)
      }
      return c.json(ok({ phase: 'ready', dataDir: validation.canonicalPath }, requestId(c)))
    } catch (error) {
      console.error('[setup] storage recovery failed', { requestId: requestId(c), error })
      return c.json(fail(500, 'storage_recovery_failed', {}, requestId(c)), 500)
    }
  })

  if (options.isDev && options.rendererDevUrl) {
    const devOrigin = options.rendererDevUrl.replace(/\/$/, '')
    app.all('*', async (c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.json(fail(404, 'Not Found', { error: 'Not Found' }, requestId(c)), 404)
      }
      const target = `${devOrigin}${c.req.path}${new URL(c.req.url).search}`
      return proxy(target, c.req.raw)
    })
  } else if (options.staticDir) {
    const staticDir = options.staticDir
    app.use('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) {
        await next()
        return
      }
      return serveStatic({ root: staticDir })(c, next)
    })
    app.notFound((c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.json(fail(404, 'Not Found', { error: 'Not Found' }, requestId(c)), 404)
      }
      if (!shouldServeSpaIndex(c.req.raw, c.req.path)) {
        return c.json(fail(404, 'Not Found', { error: 'Not Found' }, requestId(c)), 404)
      }
      return c.html(readFileSync(join(staticDir, 'index.html'), 'utf8'))
    })
  }

  return app
}
