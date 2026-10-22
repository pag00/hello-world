// Procedure instructions are authored markdown; they are rendered on the shop floor, so every bit of
// HTML is sanitized (authors are trusted to write procedures, not to run script on every tablet).
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export function renderMarkdown(md: string | null | undefined): string {
  if (!md || !md.trim()) return ''
  const html = marked.parse(md, { async: false, gfm: true, breaks: true }) as string
  const clean = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button'] })
  // links in instructions open outside the app so the step (and its lock) stays where it is
  return clean.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ')
}
