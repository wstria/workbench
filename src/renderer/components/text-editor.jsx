import CodeMirror, { EditorSelection, EditorView } from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef, useState } from 'react'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { python } from '@codemirror/lang-python'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'

const extensions = {
  '.js': [javascript()], '.jsx': [javascript({ jsx: true })], '.mjs': [javascript()], '.cjs': [javascript()],
  '.ts': [javascript({ typescript: true })], '.mts': [javascript({ typescript: true })], '.cts': [javascript({ typescript: true })],
  '.tsx': [javascript({ typescript: true, jsx: true })],
  '.json': [json()], '.py': [python()], '.pyi': [python()], '.html': [html()], '.svg': [html()], '.css': [css()],
  '.mdx': [markdown()], '.sql': [sql()],
}

export default function TextEditor({ text, onChange, extension, dark, readOnly, preferences, location, active, onSelection, onDefinition }) {
  const wrap = preferences?.editorWrap
  const [editor, setEditor] = useState(null)
  const delivered = useRef(null)
  const selectionListener = useRef(onSelection)
  selectionListener.current = onSelection
  const definitionListener = useRef(onDefinition)
  definitionListener.current = onDefinition
  const activeExtensions = useMemo(() => [...(extensions[extension] ?? []), ...(wrap ? [EditorView.lineWrapping] : []),
    EditorView.domEventHandlers.of({ keydown(event, view) {
      if (event.key !== 'F12' || !definitionListener.current) return false
      const offset = view.state.selection.main.head
      const line = view.state.doc.lineAt(offset)
      event.preventDefault()
      definitionListener.current({ line: line.number - 1, character: offset - line.from })
      return true
    } }),
    EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged) return
      const { from, to } = update.state.selection.main
      selectionListener.current?.(from < to ? { text: update.state.sliceDoc(from, to), line: update.state.doc.lineAt(from).number,
        endLine: update.state.doc.lineAt(to - 1).number } : null)
    })], [extension, wrap])
  useEffect(() => {
    if (!active || !editor || !location?.line || delivered.current?.request === location.request && delivered.current.editor === editor) return
    delivered.current = { request: location.request, editor }
    const line = editor.state.doc.line(Math.min(location.line, editor.state.doc.lines))
    editor.dispatch({ selection: EditorSelection.range(line.from, line.to), effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
    editor.focus()
  }, [editor, active, location])
  return <CodeMirror
    className="code-editor"
    height="100%"
    value={text}
    onCreateEditor={(view) => setEditor(view)}
    readOnly={readOnly}
    theme={dark ? oneDark : 'light'}
    extensions={activeExtensions}
    onChange={onChange}
    basicSetup={{ lineNumbers: preferences?.lineNumbers !== false, foldGutter: true, highlightActiveLine: true }}
    aria-label="File editor"
  />
}
