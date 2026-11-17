import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ErrorNotice } from '@/components/workbench-ui'
import { useHarnessCatalog } from '@/hooks/use-harness-catalog'

import { ModelCatalog } from '@/components/model-picker'
import { HarnessPicker } from '@/components/harness-picker'
import { catalogRevision, executableSetting, harnessDisplayName } from '@/lib/harnesses'

const api = window.workbench

export function ModelSettings({ data, active, openProviders, openHarness }) {
  const [chosenHarness, setHarness] = useState(null)
  const harness = chosenHarness ?? data.harness ?? 'pi'
  const [pending, setPending] = useState(false)
  const [selection, setSelection] = useState(null)
  const [error, setError] = useState(null)
  const catalog = useHarnessCatalog({ harness, cwd: data.cwd, executable: executableSetting(data, harness), enabled: active,
    providerRevision: catalogRevision(data, harness) })
  const defaults = harness === 'pi' ? data.model : data.harnessDefaults?.[harness]?.model
  const defaultModel = catalog.models.find(({ id }) => id === defaults)?.id ?? catalog.defaultModel
  async function choose(model) {
    setPending(true)
    setError(null)
    try { await api.setHarnessDefaults(harness, { model }) } catch (err) { setError(err) } finally { setPending(false) }
  }

  return <div className="model-settings">
    <div className="settings-choice-row">
      <div><h2>Catalog</h2><p>Choose a default model for {harnessDisplayName(data, harness)}.</p></div>
      <div className="work-actions">
        {harness !== 'pi' && defaults && <Button type="button" variant="ghost" size="sm" disabled={pending}
          onClick={() => choose('')}>Use harness default</Button>}
        <HarnessPicker data={data} value={harness} label="Model harness" description="Browse the models available to a harness."
          onValueChange={(id) => { setHarness(id); setSelection(null); setError(null) }} />
      </div>
    </div>
    <ErrorNotice error={error ?? catalog.error} />
    {!catalog.loading && !catalog.models.length && <div className="provider-harness-note">
      <p>{harness === 'pi' ? 'Connect a provider to use its models.' : 'Set up this harness to load its model catalog.'}</p>
      <Button type="button" variant="outline" size="sm" onClick={harness === 'pi' ? openProviders : openHarness}>
        {harness === 'pi' ? 'Open providers' : 'Open harness settings'}
      </Button>
    </div>}
    <ModelCatalog key={harness} models={catalog.models} value={defaultModel} onValueChange={choose} selectionLabel="Default"
      loading={catalog.loading} disabled={pending} />
  </div>
}

export function PermissionSettings({ data }) {
  const [chosenHarness, setHarness] = useState(null)
  const harness = chosenHarness ?? data.harness ?? 'pi'
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const permission = data.harnessDefaults?.[harness]?.permission ?? 'ask'
  return <div className="model-settings">
    <HarnessPicker data={data} label="Permission harness" value={harness} onValueChange={setHarness} />
    <div className="setting-row harness-setting-row">
      <div><Label htmlFor="default-permission">Default tool permissions</Label><p>Set the starting mode for new chats. You can change it in the composer.</p></div>
      <Select value={permission} disabled={pending || !data.root} onValueChange={async (value) => {
        setError(null)
        setPending(true)
        try { await api.setHarnessDefaults(harness, { permission: value }) } catch (err) { setError(err) } finally { setPending(false) }
      }}>
        <SelectTrigger id="default-permission" className="harness-select"><SelectValue /></SelectTrigger>
        <SelectContent align="start" position="popper"><SelectItem value="ask">Ask</SelectItem><SelectItem value="auto">Auto</SelectItem></SelectContent>
      </Select>
    </div>
    <dl className="settings-explainer"><dt>Ask</dt><dd>{harness === 'codex' || harness === 'claude' ? 'Runs with read-only tools in Workbench.' : 'Review approval requests from the harness before those actions run.'}</dd>
      <dt>Auto</dt><dd>Run permitted edits and commands according to the harness's local policies.</dd></dl>
    <ErrorNotice error={error} />
  </div>
}
