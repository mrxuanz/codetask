import type { Composer } from 'vue-i18n'

const SERVER_MESSAGE_KEYS: Record<string, string> = {
  用户名和密码不能为空: 'errors.emptyCredentials',
  系统已初始化: 'errors.alreadyInitialized',
  请先完成初始化: 'errors.setupRequired',
  用户名或密码错误: 'errors.invalidCredentials',
  'request failed': 'errors.requestFailed',
  未登录: 'errors.unauthorized',
  会话已过期: 'errors.sessionExpired',
  'workspaceRoot 不能为空': 'folderPicker.selectRequired',
  项目不存在: 'errors.projectNotFound'
}

export function translateApiError(message: string, t: Composer['t']): string {
  const key = SERVER_MESSAGE_KEYS[message]
  return key ? t(key) : message
}
