import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, FileText, Folder, FolderGit2, FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice, Page } from '@/components/workbench-ui'
import { SidebarContent } from '@/components/ui/sidebar'

const api = window.workbench

function TreeBranch({ directory, depth, expanded, toggle, selected, openFile, query, revision }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let current = true
    api.listFiles(directory).then((items) => { if (current) { setResult(items); setError(null) } })
      .catch((err) => { if (current) { setResult([]); setError(err) } })
    return () => { current = false }
  }, [directory, revision])
  const items = (result ?? []).filter((item) => item.directory || item.name.toLowerCase().includes(query))
  return <>
    <ErrorNotice error={error} />
    {result === null && <p className="sidebar-empty">Loading…</p>}
    {result !== null && !items.length && !error && <p className="sidebar-empty">No matching files</p>}
    <ul className="files-tree-branch">{items.map((item) => {
      const open = expanded.has(item.path)
      return <li key={item.path}><button type="button" className="tree-item" style={{ '--tree-depth': depth }}
        title={item.path} aria-expanded={item.directory ? open : undefined} aria-current={selected === item.path ? 'page' : undefined}
        onClick={() => item.directory ? toggle(item.path) : openFile(item.path)}>
        {item.directory ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="tree-indent" />}
        {item.directory ? <Folder size={15} /> : <FileText size={15} />}<span>{item.name}</span>
      </button>
      {item.directory && open && <TreeBranch directory={item.path} depth={depth + 1} expanded={expanded} toggle={toggle}
        selected={selected} openFile={openFile} query={query} revision={revision} />}</li>
    })}</ul>
  </>
}

export function FileTreeSidebar({ root, selected, query, chooseRoot, openFile, openChanges }) {
  const [expanded, setExpanded] = useState(() => new Set())
  const [revision, setRevision] = useState(0)
  const name = root?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Workspace'
  const toggle = (path) => setExpanded((old) => {
    const next = new Set(old)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  return <SidebarContent className="work-sidebar-items">
    <div className="sidebar-mode">
      <Button variant="ghost" size="sm" className="truncate" title={root} onClick={chooseRoot}><FolderOpen />{name}</Button>
      <div className="sidebar-quick-actions">
        <Button variant="ghost" size="icon-xs" aria-label="Workspace changes" title="Workspace changes" onClick={openChanges}><FolderGit2 /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="Refresh file tree" title="Refresh file tree" onClick={() => setRevision((value) => value + 1)}><RefreshCw /></Button>
      </div>
    </div>
    {root && <TreeBranch directory={root} depth={0} selected={selected} query={query.trim().toLowerCase()} expanded={expanded}
      toggle={toggle} revision={revision} openFile={openFile} />}
  </SidebarContent>
}

export function FilesPage({ root, recent, openFile, chooseRoot, chooseFiles, openChanges, openSearch }) {
  return <Page title="Files" description={root} actions={<>
    <Button variant="ghost" size="sm" onClick={openSearch}>Search workspace</Button>
    <Button variant="ghost" size="sm" onClick={openChanges}><FolderGit2 /> Changes</Button>
    <Button variant="outline" size="sm" onClick={chooseRoot}><FolderOpen /> Open folder</Button>
    <Button variant="secondary" size="sm" onClick={chooseFiles}><FileText /> Open files</Button>
  </>}>
    <div className="work-section-label">Recent files</div>
    <ul className="source-list">{recent.slice(0, 16).map((item) => <li key={item.path}>
      <button type="button" className="source-row" onClick={() => openFile(item.path)}>
        <FileText size={16} /><span><strong>{item.name}</strong><small>{item.path}</small></span>
      </button>
    </li>)}</ul>
    {!recent.length && <p className="library-empty">Choose a folder or open a file to get started.</p>}
  </Page>
}
