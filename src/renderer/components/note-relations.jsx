import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import { ErrorNotice } from '@/components/workbench-ui'

export function NoteRelations({ file, root, openFile }) {
  const [links, setLinks] = useState(null)
  const [error, setError] = useState(null)
  const [tag, setTag] = useState('')
  useEffect(() => {
    let current = true
    window.workbench.noteLinks(file.path, root).then((result) => { if (current) setLinks(result) })
      .catch((err) => { if (current) setError(err) })
    return () => { current = false }
  }, [file.path, file.revision, root])
  const sections = [
    ['Links out', links?.outgoing ?? []],
    ['Backlinks', links?.backlinks ?? []],
    ['Shared tags', links?.related.filter((row) => !tag || row.related.includes(tag)) ?? []],
  ]
  return <div className="note-relations">
    <ErrorNotice error={error} />
    {!links && !error && <p>Finding saved note links…</p>}
    {links?.tags.length > 0 && <div className="tag-list" aria-label="Note tags">{links.tags.map((item) =>
      <button key={item} type="button" aria-pressed={tag === item} onClick={() => setTag(tag === item ? '' : item)}>#{item}</button>)}</div>}
    {sections.filter(([, items]) => items.length).map(([name, items]) => <section key={name}>
      <h2>{name}</h2>
      <ul className="source-list">{items.map((item) => <li key={item.label ?? item.path}>
        <button type="button" className="source-row" disabled={!item.path} onClick={() => openFile(item.path)}>
          <FileText size={15} /><span><strong>{item.label ?? item.name}</strong>{!item.path && <small>Missing or ambiguous note</small>}</span>
        </button></li>)}</ul>
    </section>)}
    {links && !sections.some(([, items]) => items.length) && <p>Link a saved note with <code>[[note name]]</code> or add a shared <code>#tag</code>.</p>}
    {links?.truncated && <p>Large folders may have more links than are shown here.</p>}
  </div>
}
