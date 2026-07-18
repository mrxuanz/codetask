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
  项目不存在: 'errors.projectNotFound',
  path_not_absolute: 'setup.errors.pathNotAbsolute',
  path_not_writable: 'setup.errors.pathNotWritable',
  path_not_empty: 'setup.errors.pathNotEmpty',
  path_forbidden_root: 'setup.errors.pathForbiddenRoot',
  path_owned_by_other_installation: 'setup.errors.pathOwnedByOther',
  storage_data_root_marker_missing_or_invalid: 'setup.errors.markerMissing',
  storage_database_missing: 'setup.errors.databaseMissing',
  storage_locator_unreadable: 'setup.errors.locatorUnreadable',
  storage_locator_invalid: 'setup.errors.locatorInvalid',
  storage_legacy_locator_conflict: 'setup.errors.legacyLocatorConflict',
  storage_legacy_locator_migration_failed: 'setup.errors.legacyLocatorMigrationFailed',
  storage_installation_id_mismatch: 'setup.errors.installationMismatch',
  storage_validation_expired: 'setup.errors.validationExpired',
  insufficient_space: 'setup.errors.insufficientSpace'
}

export function translateApiError(message: string, t: Composer['t']): string {
  const key = SERVER_MESSAGE_KEYS[message]
  return key ? t(key) : message
}
