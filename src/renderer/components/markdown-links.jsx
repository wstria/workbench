import { useMemo, useState } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { sourceFromLink } from '../../main/source-reference.mjs'
import { ErrorNotice } from '@/components/workbench-ui'

const wikiScheme = 'workbench-wiki:'
const skipped = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference'])

function wikiLinks() {
  function visit(parent) {
    if (!parent.children || skipped.has(parent.type)) return
    parent.children = parent.children.flatMap((node) => {
      if (node.type !== 'text') { visit(node); return node }
      const matches = [...node.value.matchAll(/(?<!\\)!?\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g)]
      if (!matches.length) return node
      const result = []
      let offset = 0
      for (const match of matches) {
        const [, target, label] = match
        if (offset < match.index) result.push({ type: 'text', value: node.value.slice(offset, match.index) })
        result.push({ type: 'link', url: wikiScheme + encodeURIComponent(target.trim()), children: [{ type: 'text', value: label || target }] })
        offset = match.index + match[0].length
      }
      if (offset < node.value.length) result.push({ type: 'text', value: node.value.slice(offset) })
      return result
    })
  }
  return visit
}

const preserveWiki = (url) => (url.startsWith(wikiScheme) || sourceFromLink(url)) ? url : defaultUrlTransform(url)
const plugins = [remarkGfm, wikiLinks]

export function MarkdownNotePreview({ text, file, openFile, openWeb, openSource }) {
  const [error, setError] = useState(null)
  const body = useMemo(() => text.replace(/^(?:\uFEFF)?---\s*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, ''), [text])
  const components = {
    a: ({ href, children }) => href ? <a href={href} onClick={(event) => follow(event, href)}>{children}</a> : <span>{children}</span>,
    img: ({ src, alt }) => src ? <button type="button" className="markdown-attachment-link" onClick={(event) => follow(event, src)}>{alt || 'Open attachment'}</button> : <span>{alt}</span>,
  }

  async function follow(event, target) {
    event.preventDefault()
    setError(null)
    const source = sourceFromLink(target)
    if (source) { openSource?.(source); return }
    if (/^https?:\/\//i.test(target)) { openWeb?.(target); return }
    if (target.startsWith('#')) {
      const heading = target.slice(1).toLowerCase().replace(/[\s-]+/g, ' ')
      const headings = event.currentTarget.closest('article')?.querySelectorAll('h1,h2,h3,h4,h5,h6')
      ;[...(headings ?? [])].find((item) => item.textContent.trim().toLowerCase().replace(/[\s-]+/g, ' ') === heading)?.scrollIntoView({ block: 'nearest' })
      return
    }
    try {
      const wiki = target.startsWith(wikiScheme)
      const value = wiki ? decodeURIComponent(target.slice(wikiScheme.length)) : target
      const path = await window.workbench.knowledgeResolveLink(file, value, wiki ? 'wiki' : 'markdown')
      if (path) openFile(path)
      else setError('This link could not be opened in the current library.')
    } catch (err) { setError(err) }
  }

  return <article className="markdown-preview" aria-label="Markdown preview">
    <ErrorNotice error={error} />
    {body.trim() ? <Markdown remarkPlugins={plugins} urlTransform={preserveWiki} components={components}>{body}</Markdown>
      : <p className="text-muted-foreground">This note is empty.</p>}
  </article>
}
