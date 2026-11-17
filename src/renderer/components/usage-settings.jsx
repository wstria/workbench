import { useEffect, useState } from 'react'
import { Gauge, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/workbench-ui'
import { useHarnessCatalog } from '@/hooks/use-harness-catalog'
import { HarnessPicker } from '@/components/harness-picker'
import { ModelPicker } from '@/components/model-picker'
import { autoModelId, catalogRevision, executableSetting, harnessDisplayName, harnessNames } from '@/lib/harnesses'
import './usage-settings.css'

const api = window.workbench
const fmt = new Intl.NumberFormat()
const format = (value) => fmt.format(value ?? 0)
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
const conditions = [
  ['any', 'Any message'], ['images', 'Image attachments'], ['long', 'Long requests'],
  ['short', 'Short requests'], ['contains', 'Contains text'],
]
const amounts = [['turns', 'Monthly turns'], ['tokens', 'Monthly tokens']]
const periodName = (key) => key ? new Date(key + '-02T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : ''
const toLimits = (value) => Object.fromEntries(amounts.flatMap(([key]) => value[key] ? [[key, Number(value[key])]] : []))

function useUsage(active) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!active || !api.usageSummary) return undefined
    let current = true
    const refresh = () => api.usageSummary().then((value) => { if (current) setReport(value) }).catch((err) => { if (current) setError(err) })
    const unsubscribe = api.onChange(refresh)
    refresh()
    return () => { current = false; unsubscribe() }
  }, [active])
  return { report, error, setReport }
}

export function UsageIndicator({ openUsage }) {
  const { report } = useUsage(true)
  const amounts = report ? Object.entries(report.remaining).map(([field, count]) => {
    const leftover = report.limits[field] ? count / report.limits[field] : 1
    return { field, count, leftover }
  }).sort((a, b) => a.leftover - b.leftover) : []
  const lowest = amounts[0]
  const allowance = report?.allowances?.toSorted((a, b) => a.percentRemaining - b.percentRemaining)[0]
  const useLocal = lowest && (!allowance || lowest.leftover * 100 <= allowance.percentRemaining)
  const percent = useLocal ? Math.round(lowest.leftover * 100) : allowance?.percentRemaining
  const label = useLocal ? format(lowest.count) + ' ' + lowest.field + ' remaining this month'
    : allowance ? Math.round(allowance.percentRemaining) + '% remaining in ' + allowance.provider + ' at last check' : 'Usage'
  return <Button type="button" variant="ghost" size="icon" className="chrome-button usage-indicator" aria-label={label} title={label} onClick={openUsage}>
    <Gauge size={17} aria-hidden="true" />
    {percent != null && <span aria-hidden="true" className="usage-indicator-value">{Math.round(percent)}%</span>}
  </Button>
}

function BudgetFields({ value, onChange, compact = false }) {
  return <div className={'usage-budget-fields' + (compact ? ' compact' : '')}>
    {amounts.map(([key, name]) => <label key={key}>{name}
      <Input type="number" inputMode="numeric" min="1" step="1" max="10000000000" placeholder="No limit"
        value={value?.[key] ?? ''} onChange={(event) => onChange({ ...value, [key]: event.target.value })} />
    </label>)}
  </div>
}

function ProviderBalances() {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  async function load() {
    setPending(true)
    setError(null)
    try { setState({ payload: await api.providerUsage() }) }
    catch (err) { setError(err) }
    finally { setPending(false) }
  }
  return <section className="usage-section">
    <header className="harness-connection-row"><h2>OpenCode allowance</h2><Button type="button" size="sm" variant="outline" disabled={pending} onClick={load}>{pending ? 'Checking…' : 'Check allowance'}</Button></header>
    <p className="settings-help">Read Go allowances and Console budgets from the OpenCode account connected to this workspace.</p>
    <ErrorNotice error={error} />
    {state && !state.payload && <p className="settings-help">OpenCode did not report a connected Go or Console workspace.</p>}
    {state?.payload?.go && <div className="usage-metrics">{Object.entries(state.payload.go).map(([interval, meter]) =>
      <div className="usage-metric" key={interval}><span className="usage-capitalize">{interval} allowance</span>
        <strong>{Math.round(100 - meter.percent)}%</strong><small>remaining · resets {new Date(meter.resetsAt).toLocaleString()}</small></div>)}</div>}
    {state?.payload?.budgets?.map((budget) => <div className="settings-list-row" key={budget.id}><span>{budget.models[0]?.name || 'Console budget'}</span>
      <span>{money.format(Math.max(0, budget.limit - budget.spent))} left</span></div>)}
  </section>
}

function CodexBalances() {
  const [windows, setWindows] = useState(null)
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(false)
  async function load() {
    setPending(true)
    setError(null)
    try { setWindows(await api.codexUsage()) }
    catch (err) { setError(err) }
    finally { setPending(false) }
  }
  return <section className="usage-section">
    <header className="harness-connection-row"><h2>Codex allowance</h2><Button type="button" size="sm" variant="outline" disabled={pending} onClick={load}>{pending ? 'Checking…' : 'Check Codex allowance'}</Button></header>
    <p className="settings-help">Read the quota windows reported by the signed-in Codex account.</p>
    <ErrorNotice error={error} />
    {windows && !windows.length && <p className="settings-help">Codex did not report a subscription allowance.</p>}
    {Boolean(windows?.length) && <div className="usage-metrics">{windows.map((item) => <div className="usage-metric" key={item.id}>
      <span>{item.label}{item.interval ? ' · ' + item.interval + ' min' : ''}</span><strong>{Math.round(item.percentRemaining)}%</strong>
      <small>{item.resetsAt ? 'Remaining · resets ' + new Date(item.resetsAt).toLocaleString() : 'Remaining'}</small>
    </div>)}</div>}
  </section>
}

export function UsageSettings({ active = true }) {
  const { report, error, setReport } = useUsage(active)
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState(null)
  async function save(event) {
    event.preventDefault()
    setPending(true)
    setFailure(null)
    try { setReport(await api.setUsageLimits(toLimits(draft ?? {}))); setDraft(null) }
    catch (err) { setFailure(err) }
    finally { setPending(false) }
  }
  return <div className="usage-settings">
    <ErrorNotice error={failure ?? error} />
    {report && <>
      <div className="usage-metrics" aria-label={'WorkBench usage for ' + periodName(report.period)}>
        <div className="usage-metric"><span>Turns</span><strong>{format(report.total.turns)}</strong>
          <small>{report.remaining.turns != null ? format(report.remaining.turns) + ' remaining' : periodName(report.period)}</small></div>
        <div className="usage-metric"><span>Reported tokens</span><strong>{format(report.total.tokens)}</strong>
          <small>{report.remaining.tokens != null ? format(report.remaining.tokens) + ' remaining' : format(report.total.measured) + ' measured turns'}</small></div>
        <div className="usage-metric"><span>Estimated cost</span><strong>{report.total.priced ? money.format(report.total.costUsd) : '—'}</strong>
          <small>{report.total.priced ? format(report.total.priced) + ' priced turns' : 'Pricing unavailable'}</small></div>
      </div>
      <section className="usage-section">
        <h2>Local limits</h2>
        <p className="settings-help">Limits apply to Workbench turns in the current calendar month. Token limits count usage reported by a harness. Provider billing stays with your account.</p>
        <form className="usage-form" onSubmit={save}>
          <BudgetFields value={draft ?? report.limits} onChange={setDraft} />
          <Button type="submit" size="sm" variant="outline" disabled={pending || draft === null}>Save limits</Button>
        </form>
      </section>
      <section className="usage-section">
        <h2>By model</h2>
        {!report.rows.length && <p className="settings-help">Usage shows up here after your first turn.</p>}
        <div className="settings-list usage-model-list">{report.rows.map((row) => <div className="settings-list-row" key={row.harness + ':' + row.model}>
          <div className="settings-list-label"><strong>{row.model === '@native/default' ? harnessNames[row.harness] + ' default' : row.model}</strong><small>{harnessNames[row.harness]} · {row.provider}</small></div>
          <span>{format(row.turns)} turns</span><span>{row.measured ? format(row.tokens) + ' tokens' : 'Token count unavailable'}</span>
        </div>)}</div>
      </section>
    </>}
    <ProviderBalances />
    <CodexBalances />
  </div>
}

function RouteRow({ data, row, index, update, remove, move, count, active }) {
  const catalog = useHarnessCatalog({ harness: row.harness, cwd: data.cwd, executable: executableSetting(data, row.harness),
    enabled: active, providerRevision: catalogRevision(data, row.harness) })
  const models = catalog.models.filter((model) => model.id !== autoModelId)
  if (row.model && !models.some(({ id }) => id === row.model)) {
    models.unshift({ id: row.model, name: row.model, provider: 'Saved selection' })
  }
  return <fieldset className="usage-route">
    <legend className="sr-only">Routing rule {index + 1}</legend>
    <div className="usage-route-grid">
      <div className="work-field"><label htmlFor={'route-harness-' + index}>Harness</label>
        <HarnessPicker data={data} id={'route-harness-' + index} label="Routing harness" value={row.harness}
          onValueChange={(harness) => { if (row.harness !== harness) update({ ...row, harness, model: '' }) }} />
      </div>
      <label>Condition<select value={row.match} onChange={(event) => update({ ...row, match: event.target.value })}>
        {conditions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <div className="work-field"><label htmlFor={'route-model-' + index}>Model</label>
        <ModelPicker models={models} id={'route-model-' + index} label="Routing model" value={row.model} loading={catalog.loading}
          harnessName={harnessDisplayName(data, row.harness)} onValueChange={(model) => update({ ...row, model })} />
      </div>
      <div className="usage-route-controls">
        <Button type="button" variant="ghost" size="sm" disabled={!index} onClick={() => move(-1)} aria-label={'Move rule ' + (index + 1) + ' up'}>↑</Button>
        <Button type="button" variant="ghost" size="sm" disabled={index === count - 1} onClick={() => move(1)} aria-label={'Move rule ' + (index + 1) + ' down'}>↓</Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={remove} aria-label={'Delete rule ' + (index + 1)}><Trash2 size={14} /></Button>
      </div>
    </div>
    {row.match === 'contains' && <label>Text to match<Input value={row.contains ?? ''} required maxLength={180}
      onChange={(event) => update({ ...row, contains: event.target.value })} /></label>}
    <details><summary>Optional model limits</summary>
      <BudgetFields compact value={row.limits} onChange={(limits) => update({ ...row, limits })} />
    </details>
    <ErrorNotice error={catalog.error} />
  </fieldset>
}

export function RoutingSettings({ data, active = true }) {
  const { report, error, setReport } = useUsage(active)
  const [draft, setDraft] = useState(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState(null)
  const rules = draft ?? report?.rules ?? []
  function mutate(index, replacement) { setDraft(rules.map((rule, current) => current === index ? replacement : rule)) }
  function move(index, offset) {
    const next = [...rules]
    const [rule] = next.splice(index, 1)
    next.splice(index + offset, 0, rule)
    setDraft(next)
  }
  async function save(event) {
    event.preventDefault()
    setPending(true)
    setFailure(null)
    try { setReport(await api.setRoutingRules(rules.map((rule) => ({ ...rule, limits: toLimits(rule.limits ?? {}) })))); setDraft(null) }
    catch (err) { setFailure(err) }
    finally { setPending(false) }
  }
  return <form className="usage-settings" onSubmit={save}>
    <p className="settings-help">Choose Auto route in the model picker. Workbench uses the first matching model for that chat's harness, then falls back to an available model. A long request starts at 6,000 characters including attachments.</p>
    <ErrorNotice error={failure ?? error} />
    {rules.map((row, index) => <RouteRow key={index} data={data} row={row} index={index} count={rules.length} active={active}
      update={(next) => mutate(index, next)} move={(offset) => move(index, offset)} remove={() => setDraft(rules.filter((_, current) => current !== index))} />)}
    <div className="harness-connection-row">
      <Button type="button" variant="outline" size="sm" disabled={rules.length >= 25} onClick={() =>
        setDraft([...rules, { harness: data.harness ?? 'pi', model: '', match: 'any', contains: '', limits: {} }])}><Plus size={15} /> Add rule</Button>
      <Button type="submit" size="sm" disabled={draft === null || pending || rules.some(({ model }) => !model)}>Save routing rules</Button>
    </div>
  </form>
}
