import { createRouter, createWebHistory, type RouteComponent } from 'vue-router'
import BootstrapGate from '@renderer/components/BootstrapGate.vue'
import BootstrapRedirect from '@renderer/pages/BootstrapRedirect.vue'
import { i18n } from '@renderer/i18n'

type RouteModule = Promise<{ default: RouteComponent }>

const HomeLayout = (): RouteModule => import('@renderer/layouts/HomeLayout.vue')
const ChatPage = (): RouteModule => import('@renderer/pages/home/ChatPage.vue')
const CreateTaskPage = (): RouteModule => import('@renderer/pages/home/CreateTaskPage.vue')
const SettingsPage = (): RouteModule => import('@renderer/pages/home/SettingsPage.vue')
const TasksPage = (): RouteModule => import('@renderer/pages/home/TasksPage.vue')
const LoginPage = (): RouteModule => import('@renderer/pages/LoginPage.vue')
const SetupPage = (): RouteModule => import('@renderer/pages/SetupPage.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: BootstrapRedirect, meta: { titleKey: 'workspace.nav.chat' } },
    {
      path: '/',
      component: BootstrapGate,
      children: [
        { path: 'setup', component: SetupPage, meta: { titleKey: 'setup.title' } },
        { path: 'login', component: LoginPage, meta: { titleKey: 'login.title' } },
        {
          path: 'home',
          component: HomeLayout,
          children: [
            { path: '', component: ChatPage, meta: { titleKey: 'workspace.nav.chat' } },
            {
              path: 'create',
              component: CreateTaskPage,
              meta: { titleKey: 'workspace.nav.createTask' }
            },
            {
              path: 'tasks',
              name: 'tasks',
              component: TasksPage,
              meta: { titleKey: 'workspace.tasks.title' }
            },
            {
              path: 'tasks/:jobId',
              name: 'task-detail',
              component: TasksPage,
              meta: { titleKey: 'workspace.tasks.taskParameters' }
            },
            {
              path: 'settings',
              component: SettingsPage,
              meta: { titleKey: 'workspace.settings.title' }
            }
          ]
        }
      ]
    }
  ]
})

function updateDocumentTitle(to: (typeof router)['currentRoute']['value']): void {
  const titleKey = typeof to.meta.titleKey === 'string' ? to.meta.titleKey : null
  document.title = titleKey ? `${String(i18n.global.t(titleKey))} · CodeTask` : 'CodeTask'
}

router.afterEach(updateDocumentTitle)
window.addEventListener('codetask:locale-changed', () =>
  updateDocumentTitle(router.currentRoute.value)
)

export default router
