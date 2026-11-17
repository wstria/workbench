import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, Bookmark, Brain, FileText, FolderPlus, GitBranch, Globe, Grid2X2, List, Minus, Plus,
  RefreshCw, Search, Tag, Upload, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, ErrorNotice, Page, SearchField, Segments } from '@/components/workbench-ui'
import './knowledge.css'

const api = window.workbench
const allVaults = 'all'
const kindFilters = [['all', 'All'], ['note', 'Notes'], ['file', 'Files'], ['link', 'Links'], ['saved', 'Saved']]
const artifactKinds = [['note', 'Markdown note'], ['doc', 'Document'], ['sheet', 'Spreadsheet'],
  ['code', 'Code file'], ['design', 'Design'], ['data', 'Dataset'], ['pdf', 'PDF']]
const icons = { note: FileText, file: FileText, link: Globe, tag: Tag, memory: Brain }
const graphWidth = 920
const graphHeight = 505

function useKnowledge(method, { enabled, query, vaultId, tag, kind, favorites, refresh, mode, offset }) {
  const lastRefresh = useRef(0)
  const [state, setState] = useState({ data: null, error: null, loading: false })
  useEffect(() => {
    if (!enabled) return
    let current = true
    let started = false
    const timer = setTimeout(() => {
      started = true
      setState((prev) => ({ ...prev, loading: true, error: null }))
      const requested = refresh !== lastRefresh.current
      lastRefresh.current = refresh
      api[method]({ query, vaultId, tag, kind, favorites, refresh: requested, mode, limit: 24, offset })
        .then((data) => { if (current) setState({ data, loading: false, error: null }) })
        .catch((error) => { if (current) setState({ data: null, loading: false, error }) })
    }, query ? 135 : 0)
    return () => { current = false; if (!started) clearTimeout(timer) }
  }, [method, enabled, query, vaultId, tag, kind, favorites, refresh, mode, offset])
  return state
}

function openItem(item, openFile, openSource) {
  if (item.source?.type === 'file') return openFile?.(item.source.path)
  if (item.source) return openSource?.(item.source)
}

function VaultPicker({ vaults, selected, onChange }) {
  return <label className="knowledge-picker">
    <span>Source</span>
    <select aria-label="Knowledge source" value={selected} onChange={(event) => onChange(event.target.value)}>
      <option value={allVaults}>All sources</option>
      {vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.name}</option>)}
    </select>
  </label>
}

export function KnowledgeLibrary({ openFile, openSource, createArtifact, chooseFiles, active = true }) {
  const [vaults, setVaults] = useState([])
  const [pane, setPane] = useState('library')
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [kind, setKind] = useState('all')
  const [vaultId, setVaultId] = useState(allVaults)
  const [refresh, setRefresh] = useState(0)
  const [offset, setOffset] = useState(0)
  const [display, setDisplay] = useState('grid')
  const [managing, setManaging] = useState(false)
  const [pending, setPending] = useState(false)
  const [actionError, setActionError] = useState(null)
  const { data, error, loading } = useKnowledge('knowledgeSearch', {
    enabled: active && pane === 'library', query, vaultId, tag, kind, favorites: kind === 'saved', refresh, offset,
  })
  const rows = data?.items ?? []

  useEffect(() => {
    if (!active) return
    let current = true
    const load = () => api.knowledgeList().then((items) => { if (current) setVaults(items) })
      .catch((err) => { if (current) setActionError(err) })
    const unsubscribe = api.onChange(load)
    void load()
    return () => { current = false; unsubscribe() }
  }, [active])

  const changeSource = (id) => {
    setVaultId(id)
    setOffset(0)
    setTag('')
  }

  async function linkFolder() {
    setActionError(null)
    setPending(true)
    try {
      const vault = await api.chooseKnowledgeVault()
      if (vault) {
        setVaults((items) => items.some((item) => item.id === vault.id) ? items : [...items, vault])
        changeSource(vault.id)
        setQuery('')
        setKind('all')
        setPane('library')
      }
    } catch (err) { setActionError(err) }
    finally { setPending(false) }
  }

  async function unlinkFolder(id) {
    setActionError(null)
    try {
      await api.knowledgeRemoveVault(id)
      setVaults((items) => items.filter((item) => item.id !== id))
      if (vaultId === id) changeSource(allVaults)
      else setRefresh((value) => value + 1)
    } catch (err) { setActionError(err) }
  }

  async function makeArtifact(event, type) {
    event.currentTarget.closest('details')?.removeAttribute('open')
    setActionError(null)
    try {
      const item = await createArtifact(type)
      if (item?.path) openFile(item.path)
      setRefresh((value) => value + 1)
    } catch (err) { setActionError(err) }
  }

  return <Page title="Artifacts" description="Find and connect your notes, files, and saved sources." actions={<>
    <Button variant="ghost" size="sm" onClick={chooseFiles}><Upload /> Open files</Button>
    <Button variant="outline" size="sm" disabled={pending} onClick={linkFolder}><FolderPlus /> {pending ? 'Opening…' : 'Link a vault'}</Button>
    <details className="knowledge-create">
      <summary><Plus size={15} /> New</summary>
      <div>{artifactKinds.map(([id, label]) => <button key={id} type="button" onClick={(event) => makeArtifact(event, id)}>{label}</button>)}</div>
    </details>
  </>}>
    <ErrorNotice error={actionError} />
    <div className="work-filterbar knowledge-viewbar">
      <Segments label="Artifacts view" value={pane} onChange={setPane} options={[[ 'library', 'Library' ], [ 'graph', 'Graph' ]]} />
      <Button variant="ghost" size="sm" aria-expanded={managing} onClick={() => setManaging(!managing)}>
        <BookOpen /> {vaults.length ? 'Linked folders · ' + vaults.length : 'Linked folders'}
      </Button>
    </div>
    {managing && <section className="knowledge-vaults" aria-label="Linked folders">
      {vaults.length === 0 && <p>Select an Obsidian vault or another Markdown folder. Workbench opens the original files in place.</p>}
      {vaults.map((vault) => {
        const info = data?.vaults?.find((item) => item.id === vault.id)
        return <div className="knowledge-vault-row" key={vault.id}>
          <BookOpen size={17} aria-hidden="true" />
          <button type="button" onClick={() => changeSource(vault.id)}><strong>{vault.name}</strong><small title={vault.path}>{vault.path}</small></button>
          <small>{info?.error ?? (vault.isObsidian ? 'Obsidian vault' : 'Linked folder')}{info?.count != null ? ' · ' + info.count : ''}</small>
          <Button variant="ghost" size="icon-sm" aria-label={'Unlink ' + vault.name} title="Unlink folder" onClick={() => unlinkFolder(vault.id)}><X /></Button>
        </div>
      })}
    </section>}
    {pane === 'graph' ? <KnowledgeGraph active={active} openFile={openFile} openSource={openSource} initialVault={vaultId} /> : <>
      <div className="knowledge-controls">
        <SearchField label="Search artifacts" value={query} onChange={(value) => { setQuery(value); setOffset(0) }} />
        <VaultPicker vaults={vaults} selected={vaultId} onChange={changeSource} />
        <Button variant="ghost" size="icon-sm" aria-label="Refresh index" title="Refresh index" onClick={() => setRefresh((value) => value + 1)}><RefreshCw /></Button>
      </div>
      <div className="work-filterbar">
        <Segments label="Artifact type" value={kind} onChange={(value) => { setKind(value); setOffset(0) }} options={kindFilters} />
        <Segments label="Library layout" value={display} onChange={setDisplay} options={[[ 'grid', 'Grid' ], [ 'list', 'List' ]]} />
      </div>
      {data?.tags?.length > 0 && <div className="tag-list knowledge-tags" aria-label="Filter by tag">
        <button type="button" aria-pressed={!tag} onClick={() => { setTag(''); setOffset(0) }}>All tags</button>
        {data.tags.map((entry) => <button key={entry.tag} type="button" aria-pressed={tag === entry.tag}
          onClick={() => { setTag(tag === entry.tag ? '' : entry.tag); setOffset(0) }}>#{entry.tag} <small>{entry.count}</small></button>)}
      </div>}
      <ErrorNotice error={error} />
      {data?.vaults?.some((vault) => vault.error) && <p className="knowledge-status">Some linked folders are unavailable. See Linked folders for details.</p>}
      {data?.limited && <p className="knowledge-status">Large libraries are capped during indexing. Choose a single vault or link a smaller folder for more precise results.</p>}
      {!rows.length && (loading ? <p role="status" className="knowledge-status">Indexing sources…</p>
        : <Empty icon={Search} title={query || tag ? 'No matching artifacts' : 'No artifacts yet'}
          text={query || tag ? 'Try another search term or clear the tag filter.' : 'Link a vault, open a file, or create a note.'} />)}
      {rows.length > 0 && <p className="knowledge-status" role="status">{loading ? 'Updating results…' : data.total + (data.total === 1 ? ' result' : ' results')}</p>}
      <ul className={'knowledge-results ' + (display === 'grid' ? 'knowledge-grid' : 'knowledge-list')}>
        {rows.map((item) => {
          const Icon = icons[item.kind] ?? FileText
          const origin = item.vaultName ?? (item.source.type === 'web' ? new URL(item.source.url).hostname : 'Workbench')
          return <li key={item.id} className="knowledge-card">
            <button type="button" className="knowledge-result" onClick={() => openItem(item, openFile, openSource)}
              title={item.source.path ?? item.source.url}>
              <span className="knowledge-result-icon"><Icon size={17} aria-hidden="true" /></span>
              <span className="knowledge-result-label">
                <strong>{item.title}</strong>
                <small>{origin}{item.relative && item.relative !== item.name ? ' · ' + item.relative : ''}</small>
              </span>
              {item.favorite && <Bookmark size={14} className="knowledge-bookmark" aria-label="Saved" />}
            </button>
            {item.excerpt && <p className="knowledge-excerpt">{item.excerpt}</p>}
            {item.tags.length > 0 && <div className="tag-list">
              {item.tags.slice(0, 5).map((value) => <button key={value} type="button" onClick={() => { setTag(value); setOffset(0) }}>#{value}</button>)}
            </div>}
          </li>
        })}
      </ul>
      {(data?.hasMore || offset > 0) && <div className="work-actions">
        <Button size="sm" variant="outline" disabled={loading || !offset} onClick={() => setOffset((value) => Math.max(0, value - 24))}>Previous results</Button>
        <Button size="sm" variant="outline" disabled={loading || !data?.hasMore} onClick={() => setOffset((value) => value + 24)}>Next results</Button>
      </div>}
    </>}
  </Page>
}

function makeLayout(nodes, edges) {
  const points = new Map()
  const count = nodes.length
  if (!count) return points
  const middleX = graphWidth / 2
  const middleY = graphHeight / 2
  for (const [index, node] of nodes.entries()) {
    const angle = index * Math.PI * (3 - Math.sqrt(5))
    const r = Math.sqrt(index / count) * (count < 6 ? 125 : 215)
    points.set(node.id, { x: middleX + Math.cos(angle) * r * 1.5, y: middleY + Math.sin(angle) * r, vx: 0, vy: 0 })
  }
  const positions = [...points.values()]
  const springs = edges.map(({ from, to }) => [points.get(from), points.get(to)]).filter(([a, b]) => a && b)
  for (let tick = 0; tick < 75; tick++) {
    const cooling = 1 - tick / 86
    for (const [i, a] of positions.entries()) {
      a.vx += (middleX - a.x) * .004 * cooling
      a.vy += (middleY - a.y) * .004 * cooling
      for (let j = i + 1; j < count; j++) {
        const b = positions[j]
        const dx = a.x - b.x
        const dy = a.y - b.y
        const power = (count < 30 ? 1800 : 650) * cooling / (dx * dx + dy * dy + 100)
        a.vx += dx * power
        a.vy += dy * power
        b.vx -= dx * power
        b.vy -= dy * power
      }
    }
    for (const [a, b] of springs) {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.hypot(dx, dy) || 1
      const strength = (distance - (count < 30 ? 95 : 60)) / distance * .032 * cooling
      a.vx += dx * strength
      a.vy += dy * strength
      b.vx -= dx * strength
      b.vy -= dy * strength
    }
    for (const item of positions) {
      item.x = Math.max(38, Math.min(graphWidth - 38, item.x + item.vx))
      item.y = Math.max(37, Math.min(graphHeight - 38, item.y + item.vy))
      item.vx *= .72
      item.vy *= .72
    }
  }
  return points
}

function GraphCanvas({ nodes, edges, selectedId, onSelect, onOpen }) {
  const positions = useMemo(() => makeLayout(nodes, edges), [nodes, edges])
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const [hover, setHover] = useState(null)
  const canvas = useRef(null)
  const viewport = useRef(null)
  const drag = useRef(null)
  const spotlight = hover ?? selectedId
  const neighbors = useMemo(() => {
    const related = new Set()
    if (!spotlight) return related
    related.add(spotlight)
    for (const { from, to } of edges) {
      if (from === spotlight) related.add(to)
      if (to === spotlight) related.add(from)
    }
    return related
  }, [edges, spotlight])

  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return
    const context = element.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, graphWidth, graphHeight)
    for (const { from, to, kind } of edges) {
      const a = positions.get(from)
      const b = positions.get(to)
      const emphasized = from === spotlight || to === spotlight
      if (!a || !b) continue
      context.beginPath()
      context.moveTo(a.x, a.y)
      context.lineTo(b.x, b.y)
      context.strokeStyle = kind === 'tag' ? '#589cab' : '#8f8ea8'
      context.globalAlpha = emphasized ? .9 : spotlight ? .12 : .5
      context.lineWidth = emphasized ? 2 : 1.25
      context.stroke()
    }
  }, [edges, positions, spotlight])

  function zoom(step) {
    setView((prev) => ({ ...prev, zoom: Math.min(2.8, Math.max(.65, prev.zoom + step)) }))
  }

  function keyInput(event) {
    if (event.target !== event.currentTarget) return
    const offsets = { ArrowLeft: [24, 0], ArrowRight: [-24, 0], ArrowUp: [0, 24], ArrowDown: [0, -24] }
    const next = offsets[event.key]
    if (next) {
      event.preventDefault()
      setView((prev) => ({ ...prev, x: prev.x + next[0], y: prev.y + next[1] }))
    } else if (['+', '='].includes(event.key)) zoom(.2)
    else if (event.key === '-') zoom(-.2)
    else if (event.key === '0') setView({ x: 0, y: 0, zoom: 1 })
  }

  return <div className="knowledge-graph-canvas">
    <div className="knowledge-graph-tools" aria-label="Graph zoom">
      <Button variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(-.2)}><Minus /></Button>
      <Button variant="ghost" size="sm" onClick={() => setView({ x: 0, y: 0, zoom: 1 })} title="Reset graph view">{Math.round(view.zoom * 100)}%</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(.2)}><Plus /></Button>
    </div>
    <div ref={viewport} className="knowledge-graph-viewport" tabIndex={0} aria-label="Knowledge graph. Use arrow keys to pan and plus or minus to zoom."
      onKeyDown={keyInput} onPointerDown={(event) => {
        if (event.button !== 0 || event.target.closest('button')) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, y: event.clientY, initial: view }
      }} onPointerMove={(event) => {
        if (!drag.current) return
        const { x, y, initial } = drag.current
        setView({ ...initial, x: initial.x + event.clientX - x, y: initial.y + event.clientY - y })
      }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <div className="knowledge-graph-plane" style={{ transform: 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')' }}>
        <canvas aria-hidden="true" ref={canvas} width={graphWidth} height={graphHeight} />
        {nodes.map((node) => {
          const at = positions.get(node.id)
          const hot = spotlight === node.id
          return <button className="knowledge-node" key={node.id} type="button"
            data-kind={node.kind} data-hot={hot} data-dim={Boolean(spotlight) && !neighbors.has(node.id)}
            aria-label={node.title} tabIndex={-1} aria-pressed={node.id === selectedId}
            style={{ left: at.x / graphWidth * 100 + '%', top: at.y / graphHeight * 100 + '%' }}
            onPointerEnter={() => setHover(node.id)} onPointerLeave={() => setHover(null)}
            onClick={() => onSelect(node.id)} onDoubleClick={() => onOpen(node)}>
            <span className="knowledge-node-dot" />
            {(hot || countLabels(nodes)) && <span className="knowledge-node-label">{node.title}</span>}
          </button>
        })}
      </div>
    </div>
  </div>
}

function countLabels(nodes) { return nodes.length <= 28 }

export function KnowledgeGraph({ openFile, openSource, mode = 'library', initialVault = allVaults, active = true }) {
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState('')
  const [vaultId, setVaultId] = useState(initialVault)
  const [selection, setSelection] = useState(null)
  const [refresh, setRefresh] = useState(0)
  const graph = useKnowledge('knowledgeGraph', { enabled: active, mode, query, tag, vaultId, refresh })
  const nodes = graph.data?.nodes ?? []
  const edges = graph.data?.edges ?? []
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const picked = byId.get(selection)
  const connected = edges.filter(({ from, to }) => from === selection || to === selection)
  const related = [...new Map(connected.map(({ from, to, kind }) => {
    const next = from === selection ? to : from
    return [next, { ...byId.get(next), relation: kind === 'tag' ? 'Shared tag' : from === selection ? 'Links to' : 'Linked from' }]
  })).values()].slice(0, 25)

  function visit(item) {
    if (item?.kind === 'tag') { setTag(item.tags[0]); setSelection(null); return }
    if (item) openItem(item, openFile, openSource)
  }

  return <section className="knowledge-graph-section" aria-label={mode === 'memory' ? 'Memory graph' : 'Knowledge graph'}>
    <div className="knowledge-controls">
      <SearchField label="Filter graph" value={query} onChange={setQuery} />
      <VaultPicker vaults={graph.data?.vaults ?? []} selected={vaultId} onChange={setVaultId} />
      <Button variant="ghost" size="icon-sm" aria-label="Refresh graph" title="Refresh graph" onClick={() => setRefresh((count) => count + 1)}><RefreshCw /></Button>
      {tag && <Button variant="outline" size="sm" onClick={() => setTag('')}>#{tag} <X /></Button>}
    </div>
    <ErrorNotice error={graph.error} />
    {graph.loading && <p className="knowledge-status" role="status">Finding relationships…</p>}
    {!nodes.length && !graph.loading && <Empty icon={GitBranch} title={query || tag ? 'No matching graph nodes' : 'No sources in this graph'}
      text={mode === 'memory' ? 'Add a memory or link a Markdown vault in Artifacts.' : 'Link a Markdown vault or save a source to see it here.'} />}
    {nodes.length > 0 && <>
      <div className="knowledge-graph-legend">
        {['note', 'file', 'link', 'memory', 'tag'].filter((kind) => nodes.some((node) => node.kind === kind)).map((kind) =>
          <span key={kind} data-kind={kind}><i />{({ note: 'Notes', file: 'Files', link: 'Saved links', memory: 'Memories', tag: 'Shared tags' })[kind]}</span>)}
        <small>{nodes.length} nodes · {edges.length} connections</small>
      </div>
      <GraphCanvas nodes={nodes} edges={edges} selectedId={selection} onSelect={setSelection} onOpen={visit} />
      {graph.data?.limited && <p className="knowledge-status">This graph is limited for performance. Filter the source or search for a specific note to see it.</p>}
      <div className="knowledge-graph-detail">
        <label className="knowledge-picker">
          <span>Explore a node</span>
          <select aria-label="Graph node" value={picked?.id ?? ''} onChange={(event) => setSelection(event.target.value)}>
            <option value="">Select a node</option>
            {[...nodes].sort((a, b) => a.title.localeCompare(b.title)).map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}
          </select>
        </label>
        {picked && <div className="knowledge-node-detail">
          <div>
            <strong>{picked.title}</strong>
            <small>{picked.kind === 'memory' ? 'Approved memory' : picked.kind === 'tag' ? 'Shared tag' : picked.relative ?? picked.vaultName ?? picked.kind}</small>
          </div>
          {picked.excerpt && <p>{picked.excerpt}</p>}
          {(picked.source || picked.kind === 'tag') && <Button variant="secondary" size="sm" onClick={() => visit(picked)}>
            {picked.kind === 'tag' ? 'Filter by tag' : 'Open source'}
          </Button>}
          {related.length > 0 && <ul className="source-list" aria-label="Connected nodes">
            {related.map((node) => {
              const Icon = icons[node.kind] ?? FileText
              return <li key={node.id}><button type="button" className="source-row" onClick={() => setSelection(node.id)}>
                <Icon size={16} aria-hidden="true" /><span><strong>{node.title}</strong><small>{node.relation}</small></span>
              </button></li>
            })}
          </ul>}
        </div>}
      </div>
    </>}
  </section>
}
