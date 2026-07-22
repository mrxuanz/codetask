/**
 * Return the SPA entry point only for browser-style, extensionless page requests.
 * Static asset misses must remain 404s; returning index.html for a missing module
 * makes browsers report an opaque script error and leaves the app blank.
 */
export function shouldServeSpaIndex(request: Request, pathname: string): boolean {
  if (request.method !== 'GET') return false

  const lastSegment = pathname.split('/').filter(Boolean).at(-1) ?? ''
  if (lastSegment.includes('.')) return false

  const accept = request.headers.get('accept')?.toLowerCase()
  return !accept || accept.includes('text/html') || accept.includes('*/*')
}
