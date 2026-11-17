import { useDeferredValue, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { inspectMatches, replaceMatches } from '@/lib/file-find.mjs'

export function FileFind({ text, close, jump, pending, onChange }) {
  const [search, setSearch] = useState('')
  const [replacement, setReplacement] = useState('')
  const [sensitive, setSensitive] = useState(false)
  const [showReplacement, setShowReplacement] = useState(false)
  const [status, setStatus] = useState('')
  const pattern = useDeferredValue(search)
  const replacementPreview = useDeferredValue(replacement)
  const result = useMemo(() => inspectMatches(text, pattern, replacementPreview, sensitive), [text, pattern, replacementPreview, sensitive])
  const waiting = pattern !== search || replacementPreview !== replacement

  function replace() {
    onChange(replaceMatches(text, search, replacement, sensitive))
    setStatus(result.count + (result.count === 1 ? ' match replaced' : ' matches replaced'))
    setShowReplacement(false)
  }

  return <section className="file-find" aria-label="Find in file">
    <div className="file-find-fields">
      <Input aria-label="Find text" placeholder="Find in file" autoFocus value={search} maxLength={256} onChange={(event) => {
        setSearch(event.target.value)
        setStatus('')
      }} onKeyDown={(event) => { if (event.key === 'Enter' && result.preview[0]) jump(result.preview[0].line) }} />
      {showReplacement && <Input aria-label="Replace with" placeholder="Replace with" value={replacement} maxLength={1000}
        onChange={(event) => setReplacement(event.target.value)} />}
      <Button variant={sensitive ? 'secondary' : 'ghost'} size="sm" aria-pressed={sensitive} onClick={() => setSensitive(!sensitive)}>Match case</Button>
      {showReplacement
        ? <Button variant="outline" size="sm" disabled={waiting || !result.canReplace || pending} onClick={replace}>Replace all {result.count || ''}</Button>
        : <Button variant="ghost" size="sm" disabled={pending} onClick={() => { setStatus(''); setShowReplacement(true) }}>Replace…</Button>}
      <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={close}><X /></Button>
    </div>
    <div role="status">{status || (pattern ? (result.count ? result.count + (result.count === 1 ? ' match' : ' matches') : 'No matches') : '')}
      {showReplacement && result.count > 0 && !result.canReplace && ' · Replacement exceeds the editor size limit'}</div>
    {result.preview.length > 0 && <ol className="file-find-results" aria-label={showReplacement ? 'Replacement preview' : 'Matches'}>
      {result.preview.map((match) => <li key={match.index}><button type="button" onClick={() => jump(match.line)}>
        <span>Line {match.line}</span>
        <code>{match.before}{showReplacement ? <><del>{match.match}</del><ins>{replacementPreview}</ins></> : <mark>{match.match}</mark>}{match.after}</code>
      </button></li>)}
    </ol>}
  </section>
}
