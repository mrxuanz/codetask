import { createHonoApp } from '@codetask/server-core'
import type { Hono } from 'hono'
import type { AppContext } from './bootstrap'
import {
  getOrComposeConversation,
  getOrComposeDesign,
  getOrComposeExecution
} from './design-module'
import { createApiRoutes } from './routes/api'

export {
  bootstrapRuntime,
  ensureRuntimeReady,
  getAppContext,
  resetAppContextForTests,
  shutdownRuntime,
  type AppContext,
  type BootstrapOptions
} from './bootstrap'

export interface CreateAppHttpOptions {
  isDev: boolean
  rendererDevUrl?: string
  staticDir?: string
}

export {
  getOrComposeConversation,
  getOrComposeDesign,
  getOrComposeExecution
} from './design-module'

export function createApp(ctx: AppContext, options: CreateAppHttpOptions): Hono {
  const design = getOrComposeDesign(ctx)
  const execution = getOrComposeExecution(ctx)
  const conversation = getOrComposeConversation(ctx)
  const api = createApiRoutes(ctx, design, execution, conversation)

  return createHonoApp({
    isDev: options.isDev,
    rendererDevUrl: options.rendererDevUrl,
    staticDir: options.staticDir,
    api
  })
}
