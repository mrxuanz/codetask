/**
 * Map conversation SDK / core code → HTML filename for chat-create-html cases.
 * opencode → opencode.html, cursoracp → cursor.html, etc.
 */

export const CHAT_HTML_MARKER = 'BUSINESS_E2E_CHAT_HTML'

export function htmlFileNameForConversationCore(core: string): string {
  const c = String(core ?? 'opencode')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')

  if (c === 'opencode') return 'opencode.html'
  if (
    c === 'cursor' ||
    c === 'cursorcli' ||
    c === 'cursor-cli' ||
    c === 'cursoracp' ||
    c === 'cursor-acp' ||
    c === 'cursor-agent'
  ) {
    return 'cursor.html'
  }
  if (c === 'codex') return 'codex.html'
  if (c.includes('claude')) return 'claude.html'
  if (c.includes('gemini')) return 'gemini.html'

  const safe = c.replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'sdk'
  return `${safe}.html`
}

export function buildCreateHtmlUserMessage(fileName: string, marker: string = CHAT_HTML_MARKER): string {
  return [
    `请在当前项目工作区根目录创建一个名为 ${fileName} 的 HTML 文件。`,
    `文件内容必须是合法 HTML，并在 body 中包含纯文本标记：${marker}`,
    '创建完成后用一句话确认文件名即可，不要创建其它文件。'
  ].join('')
}
