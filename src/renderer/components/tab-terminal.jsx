import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SquareTerminal, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/workbench-ui'
import '@xterm/xterm/css/xterm.css'

const api = window.workbench
const colors = (dark) => dark
  ? { background: '#141416', foreground: '#e0e0e4', cursor: '#e0e0e4' }
  : { background: '#fafafa', foreground: '#222226', cursor: '#222226' }

export default function TerminalPanel({ tabId, active, dark, sessionId, draftCwd, onClose }) {
  const host = useRef(null)
  const runtime = useRef(null)
  const initial = useRef({ dark, sessionId, draftCwd })
  const [error, setError] = useState(null)
  useEffect(() => {
    const element = host.current
    const terminal = new Terminal({
      convertEol: false, cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace',
      scrollback: 3000, theme: colors(initial.current.dark),
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(element)
    let current = true
    const fit = () => {
      if (!element.clientWidth || !element.clientHeight) return
      addon.fit()
      void api.terminalResize(tabId, terminal.cols, terminal.rows).catch(() => {})
    }
    runtime.current = { terminal, fit }
    addon.fit()
    const unsubscribe = api.onTerminal((update) => {
      if (update.id !== tabId) return
      if (typeof update.text === 'string') terminal.write(update.text)
      if (typeof update.exitCode === 'number') terminal.writeln('\r\nShell exited (' + update.exitCode + ').')
    })
    const input = terminal.onData((value) => { void api.terminalWrite(tabId, value).catch(setError) })
    void api.terminalStart(tabId, terminal.cols, terminal.rows, initial.current.sessionId, initial.current.draftCwd).then(() => {
      if (current) { fit(); terminal.focus() }
    }).catch((err) => { if (current) setError(err) })
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => {
      current = false
      runtime.current = null
      observer.disconnect()
      unsubscribe()
      input.dispose()
      terminal.dispose()
      void api.terminalClose(tabId).catch(() => {})
    }
  }, [tabId])
  useEffect(() => {
    if (active) runtime.current?.fit()
  }, [active])
  useEffect(() => {
    if (runtime.current) runtime.current.terminal.options.theme = colors(dark)
  }, [dark])
  return <section className="newtab-terminal" aria-label="Terminal">
    <header><SquareTerminal size={15} /><span>Terminal</span><Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close terminal" title="Close terminal"><X /></Button></header>
    <ErrorNotice error={error} />
    <div className="newtab-terminal-host" ref={host} />
  </section>
}
