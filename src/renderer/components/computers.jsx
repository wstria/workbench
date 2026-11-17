import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Cloud, Laptop, LoaderCircle, Monitor, MousePointer2, Plus, Power, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Empty, ErrorNotice, Page } from '@/components/workbench-ui'
import './computers.css'

const statusLabels = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  detached: 'Disconnected',
  error: 'Needs attention',
}

function GuestPreview({ active, computer, report }) {
  const [frame, setFrame] = useState(null)
  const display = useRef(null)
  const latest = useRef(null)
  const movement = useRef(null)
  const moveRequest = useRef(null)
  const api = window.workbench
  const id = computer.id
  const owns = computer.owned

  useEffect(() => {
    setFrame(null)
    latest.current = null
  }, [id, computer.guestRunning])

  useEffect(() => {
    if (!active || !computer.guestRunning) return
    let stopped = false
    let timer
    async function sample() {
      try {
        const next = await api.computerFrame(id, latest.current?.revision)
        if (!stopped && next) {
          latest.current = next
          setFrame(next)
        }
      } catch {
        // Normal during VM shutdown and quick tab changes.
      }
      if (!stopped) timer = window.setTimeout(sample, computer.provider === 'daytona' ? 500 : 145)
    }
    void sample()
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [active, api, computer.guestRunning, computer.provider, id])

  useEffect(() => {
    if (!active || !owns) return
    display.current?.focus()
    return () => {
      cancelAnimationFrame(moveRequest.current)
      moveRequest.current = null
      void api.computerInput(id, { type: 'release' }).catch(() => {})
    }
  }, [active, api, id, owns])

  function send(input) {
    if (!owns) return
    void api.computerInput(id, input).catch(report)
  }

  function pointerAt(event, buttons) {
    if (!frame) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return null
    return { type: 'pointer',
      x: (event.clientX - bounds.left) * frame.width / bounds.width,
      y: (event.clientY - bounds.top) * frame.height / bounds.height,
      buttons: (buttons & 1) | ((buttons & 2) << 1) | ((buttons & 4) >> 1),
    }
  }

  function move(event) {
    if (!owns) return
    movement.current = pointerAt(event, event.buttons)
    if (moveRequest.current) return
    moveRequest.current = requestAnimationFrame(() => {
      moveRequest.current = null
      if (movement.current) send(movement.current)
    })
  }

  function click(event) {
    if (!owns || !frame) return
    event.preventDefault()
    cancelAnimationFrame(moveRequest.current)
    moveRequest.current = null
    if (event.type === 'pointerdown') {
      display.current?.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    send(pointerAt(event, event.buttons))
  }

  function scroll(event) {
    if (!owns || !event.deltaY) return
    const position = pointerAt(event, 0)
    if (position) {
      send({ ...position, buttons: event.deltaY < 0 ? 8 : 16 })
      send(position)
    }
  }

  function key(event, down) {
    if (!owns) return
    if (event.key === 'Escape' && event.ctrlKey && event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      if (down) void api.computerTakeover(id, false).catch(report)
      return
    }
    if (event.nativeEvent.isComposing || event.key === 'Dead' || event.key === 'Unidentified') return
    event.preventDefault()
    event.stopPropagation()
    send({ type: 'key', key: event.key, down })
  }

  if (!frame) return <div className="guest-empty">
    {computer.guestRunning || computer.status === 'starting' ? <LoaderCircle size={27} className="computer-spin" aria-hidden="true" /> : <Monitor size={27} aria-hidden="true" />}
    <span>{computer.guestRunning || computer.status === 'starting' ? 'Waiting for the guest desktop' : 'Start this computer to see its desktop.'}</span>
  </div>

  return <img
    ref={display}
    className="guest-frame"
    alt={'Live desktop of ' + computer.name}
    src={'data:image/png;base64,' + frame.data}
    width={frame.width}
    height={frame.height}
    tabIndex={owns ? 0 : -1}
    data-control={owns}
    draggable={false}
    onContextMenu={(event) => { if (owns) event.preventDefault() }}
    onPointerMove={move}
    onPointerDown={click}
    onPointerUp={click}
    onPointerCancel={() => send({ type: 'release' })}
    onWheel={scroll}
    onKeyDown={(event) => key(event, true)}
    onKeyUp={(event) => key(event, false)}
    onBlur={() => send({ type: 'release' })}
  />
}

function ComputerPanel({ active, computer, run, onChat, report }) {
  const api = window.workbench
  const starting = computer.status === 'starting'
  const stopping = computer.status === 'stopping'
  const running = computer.status === 'running'
  const remove = () => {
    const what = computer.provider === 'daytona' ? ' and its Daytona sandbox?' : ' and its guest disk?'
    if (window.confirm('Remove ' + computer.name + what)) void run(() => api.computerRemove(computer.id))
  }

  return <section className="computer-panel" aria-label={computer.name}>
    <header className="computer-panel-header">
      <div className="computer-panel-title">
        <Laptop size={23} aria-hidden="true" />
        <div><h2>{computer.name}</h2><p>{computer.image} · {statusLabels[computer.status]}</p></div>
      </div>
      <div className="work-actions">
        {onChat && <Button type="button" variant="ghost" size="sm" onClick={() => onChat(computer)}>Open agent chat <ArrowUpRight /></Button>}
        {(computer.guestRunning || starting || stopping || computer.cloudMayBeRunning) &&
          <Button type="button" size="sm" variant="outline" disabled={stopping} onClick={() => run(() => api.computerStop(computer.id))}>
            <Square /> {stopping ? 'Stopping' : 'Stop'}
          </Button>}
        {!computer.guestRunning && !starting && !stopping &&
          <Button type="button" size="sm" onClick={() => run(() => api.computerStart(computer.id))}>
            <Power /> {computer.cloudMayBeRunning ? 'Reconnect' : 'Start'}
          </Button>}
      </div>
    </header>
    <div className="computer-display">
      <GuestPreview active={active} computer={computer} report={report} />
    </div>
    <footer className="computer-panel-footer">
      <div className="computer-status" role="status">
        {starting && <LoaderCircle size={15} className="computer-spin" aria-hidden="true" />}
        <span>{computer.owned ? 'You have desktop control. Finish signing in before you release it.'
          : computer.handoff?.reason || computer.detail || (running ? 'Live preview' : statusLabels[computer.status])}</span>
        {typeof computer.progress === 'number' && <progress value={computer.progress} max={100} aria-label="Ubuntu image download" />}
      </div>
      <div className="work-actions">
        {running && computer.provider !== 'daytona' && !computer.owned && !computer.browserInstalled && <Button type="button" size="sm" variant="ghost" disabled={computer.installingBrowser} onClick={() => run(() => api.computerInstallBrowser(computer.id))}>
          {computer.installingBrowser ? 'Installing Firefox' : 'Install Firefox'}
        </Button>}
        {running && <Button type="button" size="sm" variant={computer.owned ? 'secondary' : 'outline'}
          disabled={computer.controlled && !computer.owned}
          onClick={() => run(() => api.computerTakeover(computer.id, !computer.owned))}>
          <MousePointer2 /> {computer.owned ? 'Release control' : 'Take control'}
        </Button>}
        {!computer.guestRunning && !starting && !stopping && <Button type="button" size="icon-sm" variant="ghost" aria-label={'Remove ' + computer.name}
          title="Remove computer" onClick={remove}><Trash2 /></Button>}
      </div>
    </footer>
  </section>
}

export function Computers({ active, onChat, requestedSelection }) {
  const api = window.workbench
  const [snapshot, setSnapshot] = useState(null)
  const [selection, setSelection] = useState(null)
  useEffect(() => { if (requestedSelection) setSelection(requestedSelection) }, [requestedSelection])
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [provider, setProvider] = useState('local')
  const [daytonaOpen, showDaytona] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [connecting, setConnecting] = useState(false)
  const canCreate = snapshot?.runtime || snapshot?.daytona
  const computer = snapshot?.computers.find(({ id }) => id === selection) ?? snapshot?.computers[0]

  async function refresh() {
    setSnapshot(await api.computerList())
  }

  useEffect(() => {
    if (!active) return
    let stopped = false
    const load = () => api.computerList().then((value) => {
      if (!stopped) setSnapshot(value)
    }).catch((cause) => { if (!stopped) setError(cause) })
    void load()
    const unsubscribe = api.onComputerChange(load)
    return () => { stopped = true; unsubscribe() }
  }, [active, api])

  async function run(action) {
    setError(null)
    try {
      const result = await action()
      await refresh()
      return result
    } catch (cause) { setError(cause); return null }
  }

  async function create(event) {
    event.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    try {
      const id = await run(() => api.computerCreate(name, snapshot.runtime && provider === 'local' ? 'local' : 'daytona'))
      if (id) {
        setSelection(id)
        setName('')
        setAdding(false)
      }
    } finally { setCreating(false) }
  }

  async function connect(event) {
    event.preventDefault()
    if (!apiKey || connecting) return
    setConnecting(true)
    try {
      const result = await run(async () => { await api.computerConnectDaytona(apiKey); return true })
      if (result) { setApiKey(''); showDaytona(false) }
    } finally { setConnecting(false) }
  }

  return <Page title="Computers" description="Open an isolated desktop for an agent and take control when needed."
    actions={<>
      <Button type="button" variant="ghost" disabled={!snapshot} onClick={() => showDaytona((open) => !open)}>
        <Cloud /> {snapshot?.daytona ? 'Daytona connected' : 'Connect Daytona'}
      </Button>
      {canCreate && <Button type="button" variant="outline" onClick={() => setAdding((value) => !value)}><Plus /> New computer</Button>}
    </>}>
    <ErrorNotice error={error} />
    {daytonaOpen && <form className="computer-cloud-form surface-panel" aria-label="Daytona connection" onSubmit={connect}>
      <div><h2>Daytona</h2><p>Start a private cloud desktop in your account. Usage appears in Daytona billing. New desktops stop after 15 minutes idle.</p></div>
      <div className="work-field"><label htmlFor="daytona-key">Daytona API key</label>
        <Input id="daytona-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required /></div>
      <div className="work-actions">
        <Button type="submit" size="sm" disabled={!apiKey || connecting}>{connecting ? 'Connecting…' : snapshot?.daytona ? 'Replace API key' : 'Connect'}</Button>
        {snapshot?.daytona && <Button type="button" size="sm" variant="ghost" onClick={() => run(() => api.computerDisconnectDaytona())}>Disconnect</Button>}
      </div>
    </form>}
    {snapshot && !snapshot.supported && !snapshot.daytona && <Empty icon={Laptop} title="Local computers require Apple Silicon"
      text="Open this page on an Apple Silicon Mac to create an Ubuntu computer." />}
    {snapshot?.supported && !snapshot.runtime && <section className="computer-setup">
      <Laptop size={25} aria-hidden="true" />
      <h2>Set up local computers</h2>
      <p>Workbench uses Tart to start Ubuntu guests on your Mac. The runtime download is about 23 MB. Your first Ubuntu image is about 3 GB.</p>
      <div className="work-actions">
        <Button type="button" disabled={snapshot.installing} onClick={() => run(() => api.computerInstallRuntime())}>
          {snapshot.installing && <LoaderCircle className="computer-spin" />}{snapshot.installing ? 'Installing Tart' : 'Install Tart'}
        </Button>
        <Button type="button" variant="outline" disabled={snapshot.installing} onClick={() => run(() => api.computerPickRuntime())}>Choose Tart installation</Button>
      </div>
    </section>}
    {(canCreate || snapshot?.computers.length > 0) && <>
      {!computer && !adding && <Empty icon={Laptop} title="No computers yet" text="Create a computer to start an isolated desktop." />}
      {adding && canCreate && <form className="computer-create" onSubmit={create} aria-label="New computer">
        <label htmlFor="computer-name">Computer name</label>
        <Input id="computer-name" value={name} placeholder="Research or coding" onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />
        {snapshot.runtime && snapshot.daytona && <select aria-label="Computer provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="local">Local · Tart</option><option value="daytona">Cloud · Daytona</option>
        </select>}
        <Button type="submit" disabled={!name.trim() || creating}>{creating ? 'Creating' : 'Create computer'}</Button>
      </form>}
      {snapshot.computers.length > 1 && <div className="computer-picker" role="group" aria-label="Available computers">
        {snapshot.computers.map((item) => <Button type="button" key={item.id} onClick={() => setSelection(item.id)} variant="outline"
          size="sm" aria-pressed={item.id === computer?.id}>
          <span data-state={item.status} className="computer-status-dot" />{item.name}
        </Button>)}
      </div>}
      {computer && <ComputerPanel key={computer.id} active={active} computer={computer} run={run} report={setError} onChat={onChat} />}
    </>}
  </Page>
}
