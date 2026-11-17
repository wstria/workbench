import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, FileDiff, GitBranch, Terminal, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, ErrorNotice, Page, formatDate } from '@/components/workbench-ui'
import { harnessNames } from '@/lib/harnesses'
import './review-page.css'

const api = window.workbench
const complete = (file) => file.applied.includes(-1) || !file.wholeFile && file.applied.length === file.hunkCount

function Hunk({ value, index, checked, disabled, select, openLine, source }) {
  const [expanded, setExpanded] = useState(false)
  let before = value.oldStart
  let after = value.newStart
  const firstChange = value.lines.findIndex((line) => line.startsWith('+') || line.startsWith('-'))
  const firstLine = Math.max(value.newStart + Math.max(firstChange, 0), 1)
  return <section className="review-hunk" aria-label={'Hunk ' + (index + 1)}>
    <header>
      {select && <label><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => select(event.target.checked)} />
        Lines {Math.max(value.newStart, 1)}–{Math.max(value.newStart + value.newLines - 1, 1)}</label>}
      {!select && <span>Lines {Math.max(value.newStart, 1)}–{Math.max(value.newStart + value.newLines - 1, 1)}</span>}
      {source && <Button type="button" variant="ghost" size="xs" onClick={() => openLine(firstLine)}>Open line {firstLine} <ArrowUpRight /></Button>}
    </header>
    <div className="review-code" role="region" aria-label={'Patch for hunk ' + (index + 1)} tabIndex={0}>
      {value.lines.slice(0, expanded ? undefined : 100).map((text, row) => {
        const kind = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : 'context'
        const isMeta = text.startsWith('\\')
        const oldLine = kind !== 'add' && !isMeta ? before++ : ''
        const newLine = kind !== 'remove' && !isMeta ? after++ : ''
        return <div key={row} data-review-line={kind}>
          <span aria-hidden="true">{oldLine}</span><span aria-hidden="true">{newLine}</span><code>{text || ' '}</code>
        </div>
      })}
    </div>
    {!expanded && value.lines.length > 100 && <Button variant="ghost" size="xs" onClick={() => setExpanded(true)}>Show full hunk</Button>}
  </section>
}

export function ReviewPage({ id, openFile, openSession, session }) {
  const [record, setRecord] = useState(null)
  const [filePath, setFilePath] = useState(null)
  const [choices, setChoices] = useState(() => new Map())
  const [patch, setPatch] = useState(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('')
  const [limit, setLimit] = useState(20)
  const changeKey = useRef(0)

  useEffect(() => {
    let current = true
    function refresh() {
      const key = ++changeKey.current
      api.reviewRead(id).then((next) => {
        if (!current || key !== changeKey.current) return
        setRecord(next)
        setFilePath((value) => value ?? next.files[0]?.path)
      }).catch((error) => { if (current) setError(error) })
    }
    refresh()
    const unsubscribe = api.onChange(refresh)
    return () => { current = false; unsubscribe() }
  }, [id])

  useEffect(() => {
    if (!filePath) return
    let current = true
    setPatch(null)
    setLimit(20)
    api.reviewPatch(id, filePath).then((result) => { if (current) setPatch(result) }).catch((error) => { if (current) setError(error) })
    return () => { current = false }
  }, [id, filePath])

  function selectFile(file, checked) {
    setChoices((current) => {
      const next = new Map(current)
      if (checked) next.set(file.path, true)
      else next.delete(file.path)
      return next
    })
  }

  function selectHunk(file, index, checked) {
    setChoices((current) => {
      const selected = current.get(file.path) === true
        ? patch.filter(({ index }) => !file.applied.includes(index)).map(({ index }) => index) : current.get(file.path) ?? []
      const values = checked ? [...new Set([...selected, index])] : selected.filter((value) => value !== index)
      const next = new Map(current)
      if (values.length) next.set(file.path, values)
      else next.delete(file.path)
      return next
    })
  }

  async function change(operation) {
    setPending(true)
    setError(null)
    setStatus('')
    try {
      const next = operation === 'apply'
        ? await api.reviewApply(id, [...choices].map(([path, value]) => ({ path, ...(value !== true && { hunks: value }) })))
        : await api.reviewUndo(id)
      setRecord(next)
      setChoices(new Map())
      setStatus(operation === 'apply' ? 'Selected changes applied.' : 'Tracked changes restored.')
    } catch (error) { setError(error) }
    finally { setPending(false) }
  }

  const selected = record?.files.find(({ path }) => path === filePath)
  const canChoose = record?.isolated && !record.interrupted
  const undoLabel = record?.isolated ? 'Undo last apply' : 'Undo this turn'
  return <Page title="Review changes" description={record?.title ?? session?.title}
    actions={<>
      {session && <Button variant="ghost" size="sm" onClick={() => openSession(session)}>Open chat <ArrowUpRight /></Button>}
      {record?.canUndo && !record.interrupted && <Button variant="outline" size="sm" disabled={pending}
        onClick={() => change('undo')}><Undo2 />{undoLabel}</Button>}
      {canChoose && <Button size="sm" disabled={pending || !choices.size}
        onClick={() => change('apply')}>Apply selected</Button>}
    </>}>
    <ErrorNotice error={error} />
    {status && <p role="status" className="review-result">{status}</p>}
    {!record && !error && <p role="status">Loading review…</p>}
    {record && <>
      <div className="review-receipt">
        <div><span><GitBranch size={15} />{record.isolated ? 'Apply to' : 'Working in'} {record.branch || 'Detached HEAD'}</span><code title={record.target}>{record.target}</code></div>
        <div><span>Starting revision</span><code>{record.revision.slice(0, 12)}</code></div>
        <div><span>{harnessNames[record.harness] ?? record.harness}</span><small>{record.model || 'Default model'} · {formatDate(record.at)}</small></div>
      </div>
      {record.interrupted ? <p className="review-description">An apply or undo was interrupted. Inspect the checkout before continuing.</p>
        : record.isolated ? <p className="review-description">Apply selected text changes to the target checkout. Workbench stops if any selected file changed.</p>
          : <p className="review-description">These edits are in the working checkout. Undo covers changes recorded by Workbench’s file tools. Commands and other changes remain in the checkout.</p>}
      {record.truncated && <p className="review-description">This review shows the first 80 changed files.</p>}
      <div className="review-split">
        <div className="review-files">
          <div className="review-files-header"><strong>{record.files.length} files</strong>
            {canChoose && <Button size="xs" variant="ghost" disabled={pending} onClick={() => setChoices(new Map(record.files
              .filter((file) => !file.unavailable && !complete(file)).map((file) => [file.path, true])))}>Select all</Button>}
          </div>
          {record.files.map((file) => <div className="review-file-row" key={file.path} data-selected={filePath === file.path}>
            {canChoose && <input type="checkbox" aria-label={'Select ' + file.path} checked={choices.has(file.path)}
              disabled={pending || file.unavailable || complete(file)} onChange={(event) => selectFile(file, event.target.checked)} />}
            <button type="button" aria-pressed={filePath === file.path} onClick={() => setFilePath(file.path)} title={file.path}>
              <span>{file.path}</span><small>{file.kind}{record.isolated && complete(file) && !file.unavailable && ' · Applied'}</small>
            </button>
            {record.isolated && complete(file) && !file.unavailable && <Check size={14} aria-hidden="true" />}
          </div>)}
        </div>
        <div className="review-diff">
          {selected ? <>
            <div className="review-diff-header"><strong>{selected.path}</strong>{selected.source && <Button variant="outline" size="xs" onClick={() => openFile(selected.source)}>
              Open file <ArrowUpRight /></Button>}</div>
            {selected.unavailable ? <p className="review-description">This file could not be captured as a regular text file.</p>
              : patch && patch.length === 0 ? <p className="review-description">The file contents are unchanged. Review its file status or permissions before applying.</p>
                : patch?.slice(0, limit).map((hunk) => <Hunk key={hunk.index} value={hunk} index={hunk.index}
                  source={selected.source} openLine={(line) => openFile(selected.source, { line })}
                  disabled={pending || complete(selected) || selected.applied.includes(hunk.index)}
                  checked={selected.applied.includes(hunk.index) || selected.applied.includes(-1) ||
                    choices.get(selected.path) === true || choices.get(selected.path)?.includes(hunk.index)}
                  select={canChoose && !selected.wholeFile ? (checked) => selectHunk(selected, hunk.index, checked) : null} />)}
            {patch?.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit((value) => value + 20)}>Show more hunks</Button>}
          </> : <Empty icon={FileDiff} title="Select a file to review" />}
        </div>
      </div>
      {record.commands.length > 0 && <section className="review-commands" aria-label="Recorded commands">
        <h2><Terminal size={16} /> Recorded commands</h2>
        {record.commands.map((item, index) => <details key={index}>
          <summary><code>{item.command}</code><span>{item.status === 'done' ? 'Completed' : item.status === 'failed' ? 'Failed' : item.status}
            {Number.isInteger(item.exitCode) && ' · Exit ' + item.exitCode}</span></summary>
          {item.output && <pre>{item.output}</pre>}
        </details>)}
      </section>}
    </>}
  </Page>
}
