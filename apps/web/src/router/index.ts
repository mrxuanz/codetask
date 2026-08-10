import { createRouter, createWebHistory, type RouteComponent } from 'vue-router'
import BootstrapGate from '@renderer/components/BootstrapGate.vue'
import BootstrapRedirect from '@renderer/pages/BootstrapRedirect.vue'

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
    { path: '/', component: BootstrapRedirect },
    {
      path: '/',
      component: BootstrapGate,
      children: [
        { path: 'setup', component: SetupPage },
        { path: 'login', component: LoginPage },
        {
          path: 'home',
          component: HomeLayout,
          children: [
            { path: '', component: ChatPage },
            { path: 'create', component: CreateTaskPage },
            { path: 'tasks', name: 'tasks', component: TasksPage },
            { path: 'tasks/:jobId', name: 'task-detail', component: TasksPage },
            { path: 'settings', component: SettingsPage }
          ]
        }
      ]
    }
  ]
})

export default router
