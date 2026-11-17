import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, ExternalLink, Maximize, Minus, Plus, Type } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, PasswordResponses } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

GlobalWorkerOptions.workerSrc = workerUrl

class LocalPdfResources {
  fetch({ kind, filename }) {
    return window.workbench.pdfResource(kind, filename)
  }
}

function PdfControl({ label, children, ...props }) {
  return <Button type="button" variant="ghost" size="icon-xs" aria-label={label} title={label} {...props}>{children}</Button>
}

export default function PdfViewer({ file, location, active, busy, toolbar, onNote, onOpenExternal }) {
  const canvas = useRef(null)
  const scroll = useRef(null)
  const rendered = useRef(null)
  const unlock = useRef(null)
  const [pdf, setPdf] = useState(null)
  const [page, setPage] = useState(() => location?.page ?? 1)
  const [zoom, setZoom] = useState(null)
  const [fitWidth, setFitWidth] = useState(0)
  const [fitScale, setFitScale] = useState(1)
  const [rendering, setRendering] = useState(true)
  const [showPage, setShowPage] = useState(false)
  const [error, setError] = useState(null)
  const [passwordReason, setPasswordReason] = useState(null)
  const [passwordProtected, setPasswordProtected] = useState(false)
  const [password, setPassword] = useState('')
  const [draft, setDraft] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const noteButton = useRef(null)
  const passwordInput = useId()
  const noteInput = useId()

  useEffect(() => {
    let current = true
    rendered.current = null
    setError(null)
    setPdf(null)
    setShowPage(false)
    setRendering(true)
    setPasswordReason(null)
    setPasswordProtected(false)
    const task = getDocument({
      data: new Uint8Array(file.bytes),
      BinaryDataFactory: LocalPdfResources,
      isEvalSupported: false,
      useWorkerFetch: false,
    })
    task.onPassword = (submit, reason) => {
      if (!current) return
      unlock.current = submit
      setPasswordReason(reason)
      setPasswordProtected(true)
      setRendering(false)
    }
    task.promise.then((document) => {
      if (!current) return
      setPage((previous) => Math.min(previous, document.numPages))
      setPdf(document)
    }).catch((err) => {
      if (current) {
        setError(err)
        setRendering(false)
      }
    })
    return () => { current = false; unlock.current = null; void task.destroy().catch(() => {}) }
  }, [file.bytes])

  useEffect(() => {
    if (pdf && location?.page) setPage(Math.min(location.page, pdf.numPages))
  }, [location, pdf])

  useEffect(() => {
    if (!active) return
    const element = scroll.current
    const measure = () => {
      const styles = getComputedStyle(element)
      const available = element.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)
      setFitWidth(Math.max(0, available))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [active])

  useEffect(() => {
    if (!pdf || !active || !fitWidth) return
    let current = true
    let render
    setRendering(true)
    setError(null)

    pdf.getPage(page).then(async (pdfPage) => {
      if (!current) return
      const base = pdfPage.getViewport({ scale: 1 })
      const fitted = Math.min(1, fitWidth / base.width)
      const view = pdfPage.getViewport({ scale: zoom ?? fitted })
      const ratio = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(view.width, view.height))
      const offscreen = document.createElement('canvas')
      offscreen.width = Math.max(1, Math.ceil(view.width * ratio))
      offscreen.height = Math.max(1, Math.ceil(view.height * ratio))
      render = pdfPage.render({ canvas: offscreen, viewport: view, transform: [ratio, 0, 0, ratio, 0, 0] })
      await render.promise
      if (!current) return

      const element = canvas.current
      element.width = offscreen.width
      element.height = offscreen.height
      element.style.width = view.width + 'px'
      element.style.height = view.height + 'px'
      element.getContext('2d').drawImage(offscreen, 0, 0)
      rendered.current = { page, view }
      setFitScale(fitted)
      setShowPage(true)
      setRendering(false)
    }).catch((err) => {
      if (current && err.name !== 'RenderingCancelledException') {
        rendered.current = null
        setShowPage(false)
        setError(err)
        setRendering(false)
      }
    })
    return () => { current = false; render?.cancel() }
  }, [pdf, page, zoom, fitWidth, active])

  function adjustZoom(direction) {
    setZoom((current) => Math.max(0.25, Math.min(3, (current ?? fitScale) + direction * 0.25)))
  }

  function placeNote(event) {
    const positioned = rendered.current
    if (!noteOpen || !draft.trim() || rendering || positioned?.page !== page || busy || passwordProtected) return
    const rectangle = canvas.current.getBoundingClientRect()
    const [x, y] = positioned.view.convertToPdfPoint(event.clientX - rectangle.left, event.clientY - rectangle.top)
    void onNote({ page, x, y, text: draft.trim() }).then(() => {
      setDraft('')
      setNoteOpen(false)
    }).catch(() => {})
  }

  function cancelNote() {
    setDraft('')
    setNoteOpen(false)
    noteButton.current?.focus()
  }

  return (
    <div className="pdf-viewer">
      {toolbar && pdf && !error && createPortal(
        <div className="pdf-tools" role="group" aria-label="PDF controls">
          <div className="pdf-tool-group" role="group" aria-label="Pagination">
            <PdfControl label="Previous PDF page" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft /></PdfControl>
            <span className="pdf-page-count" aria-label={`Page ${page} of ${pdf.numPages}`}>{page} <span>/</span> {pdf.numPages}</span>
            <PdfControl label="Next PDF page" disabled={page === pdf.numPages} onClick={() => setPage(page + 1)}><ChevronRight /></PdfControl>
          </div>
          <div className="pdf-tool-group" role="group" aria-label="Zoom">
            <PdfControl label="Zoom out" disabled={(zoom ?? fitScale) <= .25} onClick={() => adjustZoom(-1)}><Minus /></PdfControl>
            <span className="pdf-zoom-level">{Math.round((zoom ?? fitScale) * 100)}%</span>
            <PdfControl label="Zoom in" disabled={(zoom ?? fitScale) >= 3} onClick={() => adjustZoom(1)}><Plus /></PdfControl>
          </div>
          <PdfControl label="Fit width" aria-pressed={zoom === null} onClick={() => setZoom(null)}><Maximize /></PdfControl>
          {!passwordProtected && <PdfControl label="Add note" ref={noteButton} disabled={!showPage || rendering || busy}
            aria-expanded={noteOpen} aria-controls={noteOpen ? noteInput : undefined}
            onClick={() => { if (noteOpen) cancelNote(); else setNoteOpen(true) }}><Type /></PdfControl>}
        </div>, toolbar
      )}
      {noteOpen && pdf && !error && <div className="pdf-note-composer" id={noteInput}>
        <Input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500}
          autoFocus aria-label="PDF note" placeholder="Write a note, then click the page" disabled={busy}
          onKeyDown={(event) => { if (event.key === 'Escape') cancelNote() }} />
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancelNote}>Cancel</Button>
      </div>}
      <div className="pdf-scroll" ref={scroll} data-page-visible={showPage}>
        {error && (
          <div className="pdf-message">
            <div role="alert">
              <h2>Couldn’t open this PDF</h2>
              <p>{error.name === 'InvalidPDFException' ? 'The file appears to be damaged or incomplete.' : 'Workbench couldn’t display this document.'}</p>
            </div>
            <Button size="sm" variant="outline" onClick={onOpenExternal}><ExternalLink /> Open with default app</Button>
            <details><summary>Technical details</summary><p>{error.message}</p></details>
          </div>
        )}
        {passwordReason !== null && (
          <form className="pdf-message pdf-password" onSubmit={(event) => {
            event.preventDefault()
            unlock.current?.(password)
            setPassword('')
            setPasswordReason(null)
            setRendering(true)
          }}>
            <h2>Password protected</h2>
            <label htmlFor={passwordInput}>{passwordReason === PasswordResponses.INCORRECT_PASSWORD ? 'Incorrect password. Try again.' : 'Enter the password to view this document.'}</label>
            <div className="pdf-password-fields">
              <Input id={passwordInput} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
              <Button type="submit" size="sm" variant="secondary" disabled={!password}>Unlock</Button>
            </div>
          </form>
        )}
        {rendering && !showPage && !error && <p className="pdf-message pdf-loading" role="status">Opening PDF…</p>}
        <canvas ref={canvas} hidden={!showPage} aria-busy={rendering} aria-label={'PDF page ' + (rendered.current?.page ?? page)} className={noteOpen && draft.trim() && !rendering ? 'placing-note' : ''} onClick={placeNote} />
      </div>
    </div>
  )
}
