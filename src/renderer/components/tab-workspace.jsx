import { lazy, Suspense, useEffect, useState } from 'react'
import { SessionView } from '@/components/session-view'

const TerminalPanel = lazy(() => import('./tab-terminal'))

export function TabWorkspace({ tabId, active, launcher, workspace, session, draftCwd, ensureSession,
  openFile, chooseWorkspace, resetWorkspace, openProvider, openHarnessSettings, dark,
  openWeb, replaceWithWeb, ...context }) {
  const [terminalOpen, setTerminalOpen] = useState(false)

  useEffect(() => {
    if (!active) return
    function shortcut(event) {
      if (event.defaultPrevented) return
      if (event.ctrlKey && !event.metaKey && event.code === 'Backquote') {
        event.preventDefault()
        if (!event.repeat) setTerminalOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [active])

  return <div className="newtab-workspace">
    <SessionView tabId={tabId} active={active} session={session} workspace={workspace} ensureSession={ensureSession} openFile={openFile}
      draftCwd={draftCwd} chooseWorkspace={chooseWorkspace} resetWorkspace={resetWorkspace} openIntegrations={openProvider}
      openHarnessSettings={openHarnessSettings} openWeb={openWeb} autoFocus={!launcher && !session && active}
      searchWeb={launcher && !session ? (value, keepDraft) => keepDraft || terminalOpen ? openWeb(value) : replaceWithWeb(value) : undefined}
      {...context}
      dock={terminalOpen ? <Suspense fallback={<p className="newtab-terminal-loading">Opening terminal…</p>}>
        <TerminalPanel tabId={tabId} active={active} dark={dark} sessionId={session?.id} draftCwd={draftCwd} onClose={() => setTerminalOpen(false)} />
      </Suspense> : null}
    />
  </div>
}
