import { readFileSync } from 'fs'
import { join } from 'path'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { proxy } from 'hono/proxy'
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
  onInitialized?: (dataDir: string) => void | Promise<void>
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
        setupTokenRequired: false,
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

  app.post('/api/system/storage/validate', async (c) => {
    const body = await c.req.json<{ path?: string; allowLowSpace?: boolean }>()
    const forbiddenRoots = [options.storage.bootstrap.root, ...(options.forbiddenRoots ?? [])]
    const result =
      options.storage.phase === 'recovery_required'
        ? validateExistingStorageRoot({
            path: body.path ?? '',
            forbiddenRoots,
            nonceRepository: recoveryNonces
          })
        : validateStorageTarget({
            path: body.path ?? '',
            forbiddenRoots,
            allowLowSpace: body.allowLowSpace === true,
            nonceRepository: initializationNonces
          })
    if (!result.ok) {
      return c.json(fail(400, result.issue ?? 'storage_target_invalid', result), 400)
    }
    return c.json(ok(result))
  })

  app.post('/api/system/storage/initialize', async (c) => {
    if (options.storage.phase !== 'selection_required') {
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
      if (options.onInitialized) {
        setTimeout(() => void options.onInitialized?.(initialized.dataDir), 100).unref?.()
      }
      return c.json(ok({ phase: 'restart_required', dataDir: initialized.dataDir }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json(fail(500, 'storage_initialize_failed', { issue: message }), 500)
    }
  })

  app.post('/api/system/storage/recover', async (c) => {
    if (options.storage.phase !== 'recovery_required') {
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

    repository.write({
      schemaVersion: 1,
      dataDir: validation.canonicalPath,
      selectedAt: new Date().toISOString(),
      source: 'recovered',
      installationId: validation.installationId
    })
    if (options.onInitialized) {
      setTimeout(() => void options.onInitialized?.(validation.canonicalPath), 100).unref?.()
    }
    return c.json(ok({ phase: 'restart_required', dataDir: validation.canonicalPath }))
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
      return c.html(readFileSync(join(staticDir, 'index.html'), 'utf8'))
    })
  }

  return app
}
