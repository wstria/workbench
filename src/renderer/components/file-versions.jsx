import { useEffect, useState } from 'react'
import { FolderGit2, History, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProjectChecks } from '@/components/project-checks'
import { Empty, ErrorNotice, Page, formatDate } from '@/components/workbench-ui'

const api = window.workbench

function DiffPreview({ text }) {
  return <pre className="version-diff">{text.split('\n').map((line, index) =>
    <span key={index} data-line={/^\+[^+]/.test(line) ? 'add' : /^-[^-]/.test(line) ? 'remove' : undefined}>{line || ' '}{'\n'}</span>)}</pre>
}

export function FileTimeline({ file, dirty, onRestore }) {
  const [entries, setEntries] = useState([])
  const [selected, setSelected] = useState(null)
  const [comparison, setComparison] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    setSelected(null)
    api.fileTimeline(file.path).then((list) => { if (current) setEntries(list) }).catch((err) => { if (current) setError(err) })
    return () => { current = false }
  }, [file.path, file.revision])

  useEffect(() => {
    if (!selected) return
    let current = true
    setComparison('')
    setError(null)
    api.fileVersionPreview(file.path, selected.source, selected.id).then((text) => { if (current) setComparison(text) })
      .catch((err) => { if (current) setError(err) })
    return () => { current = false }
  }, [file.path, file.revision, selected])

  async function restore() {
    setBusy(true)
    setError(null)
    try { onRestore(await api.restoreFileVersion(file.path, selected.id, file.revision)) }
    catch (err) { setError(err) }
    finally { setBusy(false) }
  }

  return <div className="file-timeline">
    <ErrorNotice error={error} />
    <div className="version-split">
      <ul className="version-list">
        {entries.map((entry) => <li key={entry.source + entry.id}>
          <button type="button" className="source-row" aria-pressed={selected?.id === entry.id} onClick={() => setSelected(entry)}>
            <History size={15} />
            <span><strong>{entry.title}</strong><small>{entry.source === 'git' ? 'Git · ' + entry.id.slice(0, 7) : 'Local snapshot'} · {formatDate(entry.at)}</small></span>
          </button></li>)}
      </ul>
      <div className="version-body">
        {!entries.length ? <Empty icon={History} title="No versions yet" text="Workbench keeps a snapshot before each save." />
          : !selected ? <Empty icon={History} title="Select a version to compare" /> : <>
            {selected.source === 'local' && <Button variant="secondary" size="sm" onClick={restore} disabled={dirty || busy}>Restore snapshot</Button>}
            {dirty && <small>Save or reload this file before restoring a snapshot.</small>}
            {comparison && <DiffPreview text={comparison} />}
          </>}
      </div>
    </div>
  </div>
}

export function ChangesPage({ cwd, chooseRoot, openFile }) {
  const [data, setData] = useState(null)
  const [selected, setSelected] = useState(null)
  const [error, setError] = useState(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => { setSelected(null) }, [cwd])
  useEffect(() => {
    if (!cwd) return
    let current = true
    const load = () => api.workspaceChanges(cwd, selected).then((result) => { if (current) { setData(result); setError(null) } })
      .catch((err) => { if (current) setError(err) })
    const stop = api.onChange(load)
    void load()
    return () => { current = false; stop() }
  }, [cwd, selected, refresh])

  return <Page title="Changes" description={data?.root ? data.branch + ' · ' + data.root : 'Review working changes in a Git folder.'}
    actions={<><Button size="sm" variant="ghost" onClick={() => setRefresh((count) => count + 1)} aria-label="Refresh changes"><RefreshCw /></Button>
      <Button size="sm" variant="outline" onClick={chooseRoot}>Choose folder</Button></>}>
    <ErrorNotice error={error} />
    {data?.root && <ProjectChecks key={cwd} cwd={cwd} />}
    {data && !data.items.length && <Empty icon={FolderGit2} title={data.root ? 'No working changes' : 'Choose a Git folder'} />}
    {data?.items.length > 0 && <div className="version-split">
      <ul className="version-list">{data.items.map((item) => <li key={item.path}>
        <button type="button" className="source-row" title={item.path} aria-pressed={selected === item.path} onClick={() => setSelected(item.path)}>
          <code>{item.status}</code><span><strong>{item.name}</strong></span>
        </button></li>)}</ul>
      <div className="version-body">{selected ? <>
        <Button size="sm" variant="secondary" onClick={() => openFile(selected)} disabled={!data.items.some((item) => item.path === selected && !item.status.includes('D'))}>Open file</Button>
        {data.diff ? <DiffPreview text={data.diff} /> : <p>No text diff is available for this change.</p>}
      </> : <Empty icon={FolderGit2} title="Select a file to see its changes" />}</div>
    </div>}
  </Page>
}
