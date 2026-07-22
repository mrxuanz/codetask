import { mkdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { proxy } from 'hono/proxy'
import { browse, parentBrowsePath } from '../server/fs'
import { shouldServeSpaIndex } from '../server/http/spa-fallback'
import { fail, ok } from '../server/response'
import { StorageLocatorRepository, type DataDirResolution } from './storage-locator'
import { initializeStorageRoot } from './storage-initializer'
import {
  StorageValidationNonceRepository,
  validateExistingStorageRoot,
  validateStorageTarget
} from './storage-validation'

export interface SetupShellOptions {
  storage: DataDirResolution
  isDev: boolean
  rendererDevUrl?: string
  staticDir?: string
  forbiddenRoots?: readonly string[]
  /** Server mode requires a console setup token; desktop does not. */
  setupTokenRequired?: boolean
  /** Boot the full runtime in-process after storage is ready (no process restart). */
  activateStorage?: (dataDir: string) => void | Promise<void>
}

export function createSetupShell(options: SetupShellOptions): Hono {
  const app = new Hono()
  const initializationNonces = new StorageValidationNonceRepository()
  const recoveryNonces = new StorageValidationNonceRepository()
  const repository = new StorageLocatorRepository(options.storage.bootstrap)

  app.get('/api/health', (c) => c.json(ok({ status: 'ok', phase: 'storage_setup' })))
  app.get('/api/bootstrap', (c) =>
    c.json(
      ok({
        initialized: false,
        authenticated: false,
        setupTokenRequired: options.setupTokenRequired === true,
        storagePhase: options.storage.phase
      })
    )
  )
  app.get('/api/system/storage/bootstrap', (c) => {
    return c.json(
      ok({
        phase: options.storage.phase,
        defaultCandidate: options.storage.dataDir,
        source: options.storage.source === 'candidate' ? 'none' : options.storage.source,
        managed: options.storage.managed,
        issue: options.storage.issue
      })
    )
  })

  // Same browse surface as create-project; unauthenticated during storage setup only.
  app.post('/api/fs/browse', async (c) => {
    try {
      const body = await c.req.json<{ partialPath?: string }>()
      return c.json(ok(browse(body.partialPath ?? '')))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json(fail(400, message, { error: message }), 400)
    }
  })
  app.get('/api/fs/parent', async (c) => {
    try {
      const path = c.req.query('path') ?? ''
      return c.json(ok({ parentPath: parentBrowsePath(path) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json(fail(400, message, { error: message }), 400)
    }
  })
  app.post('/api/fs/mkdir', async (c) => {
    try {
      const body = await c.req.json<{ path?: string }>()
      const target = body.path?.trim()
      if (!target) {
        return c.json(fail(400, 'folderPicker.folderNameRequired', {}), 400)
      }
      const absolute = resolve(target)
      mkdirSync(absolute, { recursive: true })
      return c.json(ok({ path: absolute }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json(fail(400, message, { error: message }), 400)
    }
  })

  app.post('/api/system/storage/validate', async (c) => {
    const body = await c.req.json<{ path?: string; allowLowSpace?: boolean }>()
    const forbiddenRoots = [options.storage.bootstrap.root, ...(options.forbiddenRoots ?? [])]
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
      return c.json(ok({ ...existing, action: 'recover' as const }))
    }

    const fresh = validateStorageTarget({
      path,
      forbiddenRoots,
      allowLowSpace,
      nonceRepository: initializationNonces
    })
    if (!fresh.ok) {
      return c.json(
        fail(400, fresh.issue ?? existing.issue ?? 'storage_target_invalid', fresh),
        400
      )
    }
    return c.json(ok({ ...fresh, action: 'initialize' as const }))
  })

  app.post('/api/system/storage/initialize', async (c) => {
    if (
      options.storage.phase !== 'selection_required' &&
      options.storage.phase !== 'recovery_required'
    ) {
      return c.json(fail(409, 'storage_initialization_not_allowed', {}), 409)
    }
    const body = await c.req.json<{
      path?: string
      validationNonce?: string
      allowLowSpace?: boolean
    }>()
    const validation = validateStorageTarget({
      path: body.path ?? '',
      forbiddenRoots: [options.storage.bootstrap.root, ...(options.forbiddenRoots ?? [])],
      allowLowSpace: body.allowLowSpace === true
    })
    if (!validation.ok) {
      return c.json(fail(400, validation.issue ?? 'storage_target_invalid', validation), 400)
    }
    if (
      !body.validationNonce ||
      !initializationNonces.consume(body.validationNonce, validation.canonicalPath)
    ) {
      return c.json(
        fail(409, 'storage_validation_expired', { issue: 'storage_validation_expired' }),
        409
      )
    }

    try {
      const initialized = initializeStorageRoot({
        dataDir: validation.canonicalPath,
        locatorRepository: repository,
        source: 'desktop_setup'
      })
      if (options.activateStorage) {
        await options.activateStorage(initialized.dataDir)
      }
      return c.json(ok({ phase: 'ready', dataDir: initialized.dataDir }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json(fail(500, 'storage_initialize_failed', { issue: message }), 500)
    }
  })

  app.post('/api/system/storage/recover', async (c) => {
    if (
      options.storage.phase !== 'selection_required' &&
      options.storage.phase !== 'recovery_required'
    ) {
      return c.json(fail(409, 'storage_recovery_not_allowed', {}), 409)
    }
    const body = await c.req.json<{ path?: string; validationNonce?: string }>()
    const validation = validateExistingStorageRoot({
      path: body.path ?? '',
      forbiddenRoots: [options.storage.bootstrap.root, ...(options.forbiddenRoots ?? [])]
    })
    if (!validation.ok || !validation.installationId) {
      return c.json(fail(400, validation.issue ?? 'storage_target_invalid', validation), 400)
    }
    if (
      !body.validationNonce ||
      !recoveryNonces.consume(body.validationNonce, validation.canonicalPath)
    ) {
      return c.json(
        fail(409, 'storage_validation_expired', { issue: 'storage_validation_expired' }),
        409
      )
    }

    try {
      repository.write({
        schemaVersion: 1,
        dataDir: validation.canonicalPath,
        selectedAt: new Date().toISOString(),
        source: 'recovered',
        installationId: validation.installationId
      })
      if (options.activateStorage) {
        await options.activateStorage(validation.canonicalPath)
      }
      return c.json(ok({ phase: 'ready', dataDir: validation.canonicalPath }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json(fail(500, 'storage_recovery_failed', { issue: message }), 500)
    }
  })

  if (options.isDev && options.rendererDevUrl) {
    const devOrigin = options.rendererDevUrl.replace(/\/$/, '')
    app.all('*', async (c) => {
      if (c.req.path.startsWith('/api/')) {
        return c.json(fail(404, 'Not Found', { error: 'Not Found' }), 404)
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
        return c.json(fail(404, 'Not Found', { error: 'Not Found' }), 404)
      }
      if (!shouldServeSpaIndex(c.req.raw, c.req.path)) {
        return c.json(fail(404, 'Not Found', { error: 'Not Found' }), 404)
      }
      return c.html(readFileSync(join(staticDir, 'index.html'), 'utf8'))
    })
  }

  return app
}
