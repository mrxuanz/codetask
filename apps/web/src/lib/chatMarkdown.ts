import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: false
})

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  ALLOWED_TAGS: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'img',
    'input',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul'
  ],
  ALLOWED_ATTR: [
    'alt',
    'checked',
    'class',
    'colspan',
    'disabled',
    'href',
    'rel',
    'rowspan',
    'src',
    'target',
    'title',
    'type'
  ],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|(?:\/(?!\/)|#|\.\.?\/))/i,
  RETURN_TRUSTED_TYPE: false
}

/** Close an unfinished ``` fence so streaming markdown still parses. */
export function stabilizeStreamingMarkdown(text: string): string {
  const fenceCount = (text.match(/^```/gm) ?? []).length
  if (fenceCount % 2 === 1) {
    return `${text}\n\`\`\``
  }
  return text
}

function transformLinks(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (_match, attrs: string) => {
    const hrefMatch = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const href = hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4] ?? ''
    const safe =
      /^(https?:|mailto:|\/|#)/i.test(href) || href.startsWith('./') || href.startsWith('../')
    if (!safe) {
      return '<a>'
    }
    const next = attrs
      .replace(/\s+target\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+rel\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .concat(' target="_blank" rel="noopener noreferrer"')
    return `<a${next}>`
  })
}

export function renderChatMarkdown(
  text: string,
  options?: { breaks?: boolean; streaming?: boolean }
): string {
  const source = options?.streaming ? stabilizeStreamingMarkdown(text) : text
  if (!source.trim()) return ''

  const html = marked.parse(source, {
    async: false,
    breaks: options?.breaks === true,
    gfm: true
  }) as string

  const sanitized = String(DOMPurify.sanitize(html, PURIFY_CONFIG))
  return transformLinks(sanitized)
}
