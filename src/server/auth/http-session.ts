/** Re-export cookie / CSRF helpers from the server-core Auth module (04). */
export {
  SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  clearSessionCookies,
  createCsrfToken,
  issueSessionCookies,
  readSessionCredential,
  requestHasValidCsrf,
  verifyCsrfToken,
  type SessionCredential
} from '@codetask/server-core/modules/auth'
