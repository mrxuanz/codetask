import { createRouter, createWebHistory } from 'vue-router'
import BootstrapGate from '@renderer/components/BootstrapGate.vue'
import BootstrapRedirect from '@renderer/pages/BootstrapRedirect.vue'
import HomeLayout from '@renderer/layouts/HomeLayout.vue'
import ChatPage from '@renderer/pages/home/ChatPage.vue'
import CreateTaskPage from '@renderer/pages/home/CreateTaskPage.vue'
import SettingsPage from '@renderer/pages/home/SettingsPage.vue'
import TasksPage from '@renderer/pages/home/TasksPage.vue'
import LoginPage from '@renderer/pages/LoginPage.vue'
import SetupPage from '@renderer/pages/SetupPage.vue'

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
