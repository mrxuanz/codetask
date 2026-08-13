import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import axe from 'axe-core'
import { JSDOM } from 'jsdom'
import { createSSRApp } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { renderToString } from '@vue/server-renderer'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const webRoot = resolve(repositoryRoot, 'apps/web')

async function createVueLoader() {
  return createServer({
    root: webRoot,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': resolve(webRoot, 'src')
      }
    },
    server: { middlewareMode: true }
  })
}

function createEnglishI18n(messages) {
  return createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en: messages }
  })
}

async function assertNoSeriousAxeViolations(bodyHtml, pageName) {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head><title>${pageName} · CodeTask</title></head><body>${bodyHtml}</body></html>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1/' }
  )
  dom.window.eval(axe.source)
  const results = await dom.window.axe.run(dom.window.document, {
    resultTypes: ['violations'],
    rules: {
      // JSDOM has no layout engine, so contrast must remain a browser-level check.
      'color-contrast': { enabled: false }
    }
  })
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical'
  )
  assert.equal(
    serious.length,
    0,
    `${pageName} has serious axe violations: ${JSON.stringify(
      serious.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target)
      }))
    )}`
  )
  dom.window.close()
}

test('setup credentials form has no serious axe violations', async (t) => {
  const loader = await createVueLoader()
  t.after(async () => loader.close())
  const [{ default: CredentialsForm }, { default: en }] = await Promise.all([
    loader.ssrLoadModule('/src/components/auth/CredentialsForm.vue'),
    loader.ssrLoadModule('/src/i18n/locales/en.ts')
  ])
  const app = createSSRApp(CredentialsForm, {
    title: 'Create administrator account',
    description: 'Configure the local administrator credentials.',
    submitLabel: 'Continue',
    submittingLabel: 'Saving',
    passwordAutoComplete: 'new-password',
    showSetupToken: true,
    enforceCredentialsPolicy: true,
    onSubmit: async () => undefined
  })
  app.use(createEnglishI18n(en))
  const markup = await renderToString(app)
  await assertNoSeriousAxeViolations(`<main>${markup}</main>`, 'Setup')
})

test('home and task routes have no serious axe violations', async (t) => {
  const loader = await createVueLoader()
  t.after(async () => loader.close())
  const [
    { default: HomeLayout },
    { default: ThreadMain },
    { default: TasksPage },
    { default: en }
  ] = await Promise.all([
    loader.ssrLoadModule('/src/layouts/HomeLayout.vue'),
    loader.ssrLoadModule('/src/components/home/ThreadMain.vue'),
    loader.ssrLoadModule('/src/pages/home/TasksPage.vue'),
    loader.ssrLoadModule('/src/i18n/locales/en.ts')
  ])

  for (const [path, name] of [
    ['/home', 'Workspace'],
    ['/home/tasks', 'Tasks']
  ]) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/home', component: ThreadMain },
        { path: '/home/tasks', component: TasksPage }
      ]
    })
    await router.push(path)
    await router.isReady()
    const app = createSSRApp(HomeLayout)
    app.use(createEnglishI18n(en))
    app.use(router)
    const markup = await renderToString(app)
    await assertNoSeriousAxeViolations(`<div id="app">${markup}</div>`, name)
  }
})
