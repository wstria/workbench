import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ExternalLink, FileText, FolderOpen, RefreshCw, Save, Search } from 'lucide-react'
import { FileFind } from '@/components/file-find'
import { MarkdownNotePreview } from '@/components/markdown-links'
import { NoteRelations } from '@/components/note-relations'
import { FileTimeline } from '@/components/file-versions'
import { Button } from '@/components/ui/button'
import { Empty, ErrorNotice, Segments } from '@/components/workbench-ui'

const api = window.workbench
const CodeEditor = lazy(() => import('./text-editor'))
const PdfViewer = lazy(() => import('./pdf-viewer'))
const markdownViews = [['edit', 'Edit'], ['preview', 'Preview']]
const supportedLanguages = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.cjs', '.mjs', '.jsx', '.py', '.pyi'])

function ImageView({ file }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return <div className="image-preview">{url && (file.kind === 'media'
    ? file.mime.startsWith('audio/') ? <audio controls src={url} aria-label={file.name} />
      : <video controls src={url} aria-label={file.name} />
    : <img src={url} alt={file.name} />)}</div>
}

function columnName(number) {
  let name = ''
  while (number > 0) {
    number -= 1
    name = String.fromCharCode(65 + number % 26) + name
    number = Math.floor(number / 26)
  }
  return name
}

function SheetEditor({ file, edits, setEdits, setError, pending }) {
  const [name, setName] = useState('')
  const [rowStart, setRowStart] = useState(1)
  const [columnStart, setColumnStart] = useState(1)
  const [sheet, setSheet] = useState(null)
  useEffect(() => {
    let current = true
    setSheet(null)
    api.readSheet(file.path, name, rowStart, columnStart).then((data) => { if (current) setSheet(data) })
      .catch((error) => { if (current) setError(error) })
    return () => { current = false }
  }, [file.path, file.revision, name, rowStart, columnStart, setError])
  if (!sheet) return <p className="file-loading">Loading worksheet…</p>

  return (
    <div className="sheet-editor">
      <div className="sheet-toolbar">
        <select value={sheet.name} aria-label="Worksheet" onChange={(event) => { setName(event.target.value); setRowStart(1); setColumnStart(1) }}>
          {sheet.names.map((name) => <option key={name}>{name}</option>)}
        </select>
        <span className="sheet-position">{columnName(columnStart)}{rowStart}–{columnName(columnStart + sheet.rows[0].length - 1)}{rowStart + sheet.rows.length - 1}</span>
        <div className="work-actions">
          <Button size="icon-xs" variant="ghost" title="Previous columns" aria-label="Previous columns" disabled={columnStart === 1} onClick={() => setColumnStart(Math.max(1, columnStart - 10))}><ArrowLeft /></Button>
          <Button size="icon-xs" variant="ghost" title="Next columns" aria-label="Next columns" disabled={columnStart + 10 > 16384} onClick={() => setColumnStart(columnStart + 10)}><ArrowRight /></Button>
          <Button size="icon-xs" variant="ghost" title="Previous rows" aria-label="Previous rows" disabled={rowStart === 1} onClick={() => setRowStart(Math.max(1, rowStart - 28))}><ArrowUp /></Button>
          <Button size="icon-xs" variant="ghost" title="Next rows" aria-label="Next rows" disabled={rowStart + 28 > 1048576} onClick={() => setRowStart(rowStart + 28)}><ArrowDown /></Button>
        </div>
      </div>
      <div className="sheet-scroll">
        <table aria-label="Spreadsheet cells">
          <thead><tr><th aria-hidden="true" />{sheet.rows[0].map((_, index) => <th key={index} scope="col">{columnName(columnStart + index)}</th>)}</tr></thead>
          <tbody>
            {sheet.rows.map((columns, rowOffset) => {
              const row = rowStart + rowOffset
              return (
                <tr key={row}>
                  <th scope="row">{row}</th>
                  {columns.map((original, columnOffset) => {
                    const column = columnStart + columnOffset
                    const key = JSON.stringify([sheet.name, row, column])
                    return <td key={column}><input aria-label={'Cell ' + columnName(column) + row} readOnly={pending}
                      value={edits[key]?.value ?? original.value} title={original.formula ? 'Result: ' + original.display : original.display}
                      onChange={(event) => {
                        const value = event.target.value
                        setEdits((current) => {
                          const next = { ...current }
                          if (value === original.value) delete next[key]
                          else next[key] = { name: sheet.name, row, column, value }
                          return next
                        })
                      }} /></td>
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function FileView({ path, location, openSource, active, dark, onDirty, onDraft, useInChat, editSelection, root, project, openFile, openWeb, preferences }) {
  const [file, setFile] = useState(null)
  const [text, setText] = useState('')
  const [edits, setEdits] = useState({})
  const [view, setView] = useState('editor')
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  const [pdfControls, setPdfControls] = useState(null)
  const [markdownView, setMarkdownView] = useState('edit')
  const [selection, setSelection] = useState(null)
  const [findOpen, setFindOpen] = useState(false)
  const [problemsOpen, setProblemsOpen] = useState(false)
  const [diagnostics, setDiagnostics] = useState(null)
  const [languageError, setLanguageError] = useState(null)
  const [definitions, setDefinitions] = useState(null)
  const markdownEditor = useRef(null)
  const isMarkdown = file?.kind === 'text' && ['.md', '.markdown'].includes(file.extension)
  const canCheck = file?.kind === 'text' && supportedLanguages.has(file.extension) && Boolean(project)
  const dirty = (file?.kind === 'text' && file.text !== text) || Object.keys(edits).length > 0

  function replace(next) {
    setFile(next)
    setText(next.text ?? '')
    setEdits({})
    setSelection(null)
  }

  useEffect(() => {
    let current = true
    api.readFile(path).then((next) => { if (current) replace(next) }).catch((err) => { if (current) setError(err) })
    return () => { current = false }
  }, [path])

  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  useEffect(() => {
    const draft = dirty && file?.kind === 'text' ? text : undefined
    onDraft(draft)
    return () => onDraft(undefined)
  }, [dirty, file?.kind, text, onDraft])

  useEffect(() => {
    if (!active || !file || (!location?.line && !location?.page)) return
    setView('editor')
    if (!isMarkdown || !location.line) return
    setMarkdownView('edit')
    const frame = requestAnimationFrame(() => {
      const editor = markdownEditor.current
      if (!editor) return
      const lines = editor.value.split('\n')
      const index = Math.max(0, Math.min(lines.length - 1, location.line - 1))
      const start = lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0)
      editor.focus({ preventScroll: true })
      editor.setSelectionRange(start, start + lines[index].length)
      editor.scrollTop = Math.max(0, index * Number.parseFloat(getComputedStyle(editor).lineHeight) - editor.clientHeight / 3)
    })
    return () => cancelAnimationFrame(frame)
  }, [active, file?.path, isMarkdown, location])

  useEffect(() => {
    if (!active || !problemsOpen || !canCheck) return
    let current = true
    const stop = api.onEditorProblems((event) => {
      if (current && event.path === file.path) setDiagnostics(event.diagnostics)
    })
    const timer = setTimeout(() => {
      api.editorLanguageSync(project, path, text).then((result) => {
        if (current) { setDiagnostics(result); setLanguageError(null) }
      }).catch((error) => {
        if (current) setLanguageError(error)
      })
    }, 300)
    return () => { current = false; clearTimeout(timer); stop() }
  }, [active, problemsOpen, canCheck, file?.path, project, path, text])

  useEffect(() => {
    if (!canCheck) return
    return () => { void api.editorLanguageClose(project, path).catch(() => {}) }
  }, [canCheck, project, path])

  async function goToDefinition(position) {
    setLanguageError(null)
    setDefinitions(null)
    try {
      const matches = await api.editorDefinition(project, path, text, position)
      if (matches.length === 1) {
        await openFile(matches[0].path, { line: matches[0].line })
      } else {
        setDefinitions(matches)
        setProblemsOpen(true)
      }
    } catch (error) {
      setLanguageError(error)
      setProblemsOpen(true)
    }
  }

  async function save(change) {
    setPending(true)
    setError(null)
    try { replace(await api.saveFile(path, file.revision, change)) }
    catch (err) { setError(err); throw err }
    finally { setPending(false) }
  }

  function saveDraft() {
    if (!dirty || pending) return
    const change = file.kind === 'text' ? { kind: 'text', text } : { kind: 'sheet', cells: Object.values(edits) }
    void save(change).catch(() => {})
  }

  async function reload() {
    if (dirty && !confirm('Discard unsaved changes and reload from disk?')) return
    setError(null)
    try { replace(await api.readFile(path)) } catch (err) { setError(err) }
  }

  return (
    <div className="file-pane" onKeyDownCapture={(event) => {
      if (active && file?.kind === 'text' && view === 'editor' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        event.stopPropagation()
        setFindOpen(true)
      }
      if (active && findOpen && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setFindOpen(false)
      }
    }} onKeyDown={(event) => {
      if (active && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveDraft()
      }
    }}>
      <header className="file-heading">
        <div className="file-title" title={path}>
          <FileText size={15} aria-hidden="true" />
          <span>{file?.name ?? path.split('/').pop()}</span>
        </div>
        {file?.kind === 'pdf' && <div className="file-header-tools" ref={setPdfControls} />}
        {isMarkdown && view === 'editor' && <Segments label="Markdown view" value={markdownView} onChange={setMarkdownView} options={markdownViews} />}
        <div className="file-header-actions">
          <Button variant="ghost" size="icon-sm" aria-label="Reveal original file" title="Reveal original file" onClick={() => api.revealFile(path).catch(setError)}><FolderOpen /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Open in default app" title="Open in default app" onClick={() => api.openExternal(path).catch(setError)}><ExternalLink /></Button>
          {file?.kind === 'text' && view === 'editor' && <Button variant="ghost" size="icon-sm" aria-label="Find in file" title="Find in file"
            aria-pressed={findOpen} onClick={() => setFindOpen(!findOpen)}><Search /></Button>}
          {canCheck && view === 'editor' && <Button variant="ghost" size="sm" aria-pressed={problemsOpen}
            onClick={() => setProblemsOpen(!problemsOpen)}>Problems{diagnostics?.length ? ' · ' + diagnostics.length : ''}</Button>}
          {view === 'editor' && (!isMarkdown || markdownView === 'edit') && selection?.text.trim() && editSelection
            ? <Button variant="ghost" size="sm" onClick={() => editSelection(selection)}>Edit selection</Button>
            : <Button variant="ghost" size="sm" onClick={useInChat}>Use in chat</Button>}
          {isMarkdown && <Button variant="ghost" size="sm" aria-pressed={view === 'links'} onClick={() => setView(view === 'links' ? 'editor' : 'links')}>Links</Button>}
          {file && <Button variant="ghost" size="sm" aria-pressed={view === 'history'} onClick={() => setView(view === 'history' ? 'editor' : 'history')}>Timeline</Button>}
          {dirty && <small>Unsaved changes</small>}
          <Button variant="ghost" size="icon-sm" aria-label="Reload from disk" title="Reload from disk" disabled={pending} onClick={reload}><RefreshCw /></Button>
          {['text', 'sheet'].includes(file?.kind) && <Button variant="outline" size="sm" disabled={!dirty || pending} onClick={saveDraft}><Save /> Save</Button>}
        </div>
      </header>
      <ErrorNotice error={error} />
      {file?.kind === 'text' && view === 'editor' && findOpen && <FileFind text={text} pending={pending}
        close={() => setFindOpen(false)} jump={(line) => openFile(path, { line })} onChange={(next) => { setSelection(null); setText(next) }} />}
      {canCheck && view === 'editor' && problemsOpen && <section className="file-find editor-problems" aria-label="Problems">
        <div className="editor-problems-head"><strong>Problems</strong><small>Press F12 on a symbol to open its definition</small></div>
        <ErrorNotice error={languageError} />
        {definitions && (definitions.length
          ? <ol aria-label="Definitions" className="file-find-results">{definitions.map((item) => <li key={item.path + ':' + item.line}>
            <button type="button" onClick={() => openFile(item.path, { line: item.line })}>{item.path} · Line {item.line}</button>
          </li>)}</ol>
          : <p role="status">No definition in this project.</p>)}
        {!languageError && (diagnostics?.length
          ? <ol className="file-find-results" aria-label="Diagnostics">{diagnostics.map((item, index) => <li key={index}>
            <button type="button" onClick={() => openFile(path, { line: item.line })}><strong>{item.severity} · {item.line}:{item.column}</strong>
              <code>{item.message}</code></button>
          </li>)}</ol>
          : <p role="status">{diagnostics ? 'No reported problems' : 'Starting local language server…'}</p>)}
      </section>}
      {!file && !error && <p className="file-loading">Opening…</p>}
      {file && view === 'links' && <NoteRelations file={file} root={root} openFile={openFile} />}
      {file && view === 'history' && <FileTimeline file={file} dirty={dirty} onRestore={replace} />}
      {file && view === 'editor' && (
        <Suspense fallback={<p className="file-loading">Opening editor…</p>}>
          {isMarkdown && <>
            <textarea ref={markdownEditor} className="markdown-editor" aria-label="Markdown editor" placeholder="Start writing…" autoFocus={active}
              hidden={markdownView === 'preview'} value={text} readOnly={pending} onChange={(event) => {
                setSelection(null)
                setText(event.target.value)
              }} onSelect={(event) => {
                const { value, selectionStart, selectionEnd } = event.currentTarget
                const line = value.slice(0, selectionStart).split('\n').length
                setSelection(selectionStart < selectionEnd ? { line, text: value.slice(selectionStart, selectionEnd) } : null)
              }} />
            {markdownView === 'preview' && <MarkdownNotePreview text={text} file={path} openFile={openFile} openWeb={openWeb} openSource={openSource} />}
          </>}
          {file.kind === 'text' && !isMarkdown && <CodeEditor location={location} active={active} text={text} onChange={setText}
            onSelection={setSelection} onDefinition={canCheck ? goToDefinition : undefined} extension={file.extension} dark={dark} readOnly={pending} preferences={preferences} />}
          {file.kind === 'sheet' && <SheetEditor file={file} edits={edits} setEdits={setEdits} setError={setError} pending={pending} />}
          {file.kind === 'pdf' && <PdfViewer location={location} file={file} active={active} busy={pending} toolbar={pdfControls} onNote={(note) => save({ kind: 'pdf', ...note })} onOpenExternal={() => api.openExternal(path).catch(setError)} />}
          {['image', 'media'].includes(file.kind) && <ImageView file={file} />}
          {file.kind === 'external' && <div className="file-external"><Empty icon={FileText} title="Open in a desktop app" text="This file format or size needs an external viewer." /><Button variant="outline" onClick={() => api.openExternal(path).catch(setError)}><ExternalLink /> Open with default app</Button></div>}
        </Suspense>
      )}
    </div>
  )
}
