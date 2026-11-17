import { useEffect, useState } from 'react'
import { CircleCheck, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/workbench-ui'

const api = window.workbench

export function ProjectChecks({ cwd }) {
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(null)
  const [executable, setExecutable] = useState('')
  const [args, setArgs] = useState('')
  const [afterEdits, setAfterEdits] = useState(false)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  function read(value) {
    setSaved(value)
    setExecutable(value?.executable ?? '')
    setArgs(value?.args.join('\n') ?? '')
    setAfterEdits(Boolean(value?.afterEdits))
  }

  useEffect(() => {
    let current = true
    api.projectCheck(cwd).then((project) => {
      if (!current) return
      if (project) {
        read(project.config)
        setLoaded(true)
      }
    }).catch((error) => { if (current) setError(error) })
    return () => { current = false }
  }, [cwd])

  async function change(action) {
    setPending(true)
    setError(null)
    setResult(null)
    try {
      if (action === 'run') {
        setResult(await api.runProjectCheck(cwd))
      } else {
        read(await api.saveProjectCheck(cwd, action === 'remove' ? null : {
          executable, args: args.split(/\r?\n/).filter(Boolean), afterEdits,
        }))
      }
    } catch (error) { setError(error) }
    finally { setPending(false) }
  }

  const dirty = executable !== (saved?.executable ?? '') || args !== (saved?.args.join('\n') ?? '') || afterEdits !== Boolean(saved?.afterEdits)
  if (!loaded) return <ErrorNotice error={error} />
  return <details className="surface-panel project-checks">
    <summary><Terminal size={16} />Project checks{saved?.afterEdits && <small>Runs after edits</small>}</summary>
    <form onSubmit={(event) => { event.preventDefault(); void change('save') }}>
      <p>Configure a trusted command to run in this project. Checks on separate copies run in their own checkout.</p>
      <label>Executable <Input placeholder="npm or /absolute/path/to/executable" value={executable} maxLength={500}
        onChange={(event) => setExecutable(event.target.value)} /></label>
      <label>Arguments <textarea rows={3} placeholder="One argument per line" value={args}
        onChange={(event) => setArgs(event.target.value)} /></label>
      <label className="project-check-after"><input type="checkbox" checked={afterEdits}
        onChange={(event) => setAfterEdits(event.target.checked)} />Run after coding turns with recorded edits</label>
      <div className="work-actions">
        {saved && <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => change('remove')}>Remove</Button>}
        <Button type="button" variant="outline" size="sm" disabled={pending || !saved || dirty} onClick={() => change('run')}>Run check</Button>
        <Button size="sm" disabled={pending || !dirty || !executable.trim()}>Save check</Button>
      </div>
    </form>
    <ErrorNotice error={error} />
    {result && <div className="project-check-result" role="status">
      <span><CircleCheck size={15} />{result.status === 'done' ? 'Check passed' : 'Check failed'}
        {result.exitCode !== null && ' · Exit ' + result.exitCode}</span>
      {result.output && <pre>{result.output}</pre>}
    </div>}
  </details>
}
