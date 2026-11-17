import { useState } from 'react'
import { Check, CircleAlert, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ErrorNotice } from '@/components/workbench-ui'
import { useHarnessCatalog } from '@/hooks/use-harness-catalog'
import { HarnessGrid, HarnessMark, HarnessPicker } from '@/components/harness-picker'
import { catalogRevision, executableSetting, harnessDisplayName } from '@/lib/harnesses'

const api = window.workbench
const setupCommand = { opencode: 'opencode auth login', hermes: 'hermes setup', codex: 'codex login', claude: 'claude auth login' }

function NativeModels({ harness, models, save, pending }) {
  const [draft, setDraft] = useState(models.join('\n'))
  return <div className="work-field">
    <Label htmlFor={'native-models-' + harness}>Model IDs</Label>
    <textarea id={'native-models-' + harness} className="native-models-input" rows={4} value={draft}
      onChange={(event) => setDraft(event.target.value)} placeholder="One model ID or alias per line" />
    <div className="harness-connection-row">
      <p>Use models supported by your connected provider. Leave empty to use the harness default.</p>
      <Button type="button" size="sm" variant="outline" disabled={pending || draft === models.join('\n')} onClick={() => save(() =>
        api.setNativeModels(harness, draft.split('\n').map((model) => model.trim()).filter(Boolean)))}>Save model IDs</Button>
    </div>
  </div>
}

function CustomAcpSettings({ saved, save, pending }) {
  const [name, setName] = useState(saved?.name ?? 'Custom ACP')
  const [args, setArgs] = useState((saved?.args ?? []).join('\n'))
  return <form className="work-field acp-form" onSubmit={(event) => {
    event.preventDefault()
    void save(() => api.setCustomAcp({ name, args: args.split(/\r?\n/).filter((value) => value.length > 0) }))
  }}>
    <div className="work-field">
      <Label htmlFor="acp-display-name">Harness name</Label>
      <Input id="acp-display-name" required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} />
    </div>
    <div className="work-field">
      <Label htmlFor="acp-launch-arguments">Launch arguments</Label>
      <textarea id="acp-launch-arguments" className="native-models-input" rows={3} value={args}
        onChange={(event) => setArgs(event.target.value)} placeholder="One argument per line" />
    </div>
    <div className="harness-connection-row">
      <p>Choose an installed ACP v1 executable. Configure credentials in the harness itself.</p>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>Save connection</Button>
    </div>
  </form>
}

export function HarnessSettings({ data, active, openProviders }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(null)
  const [revision, setRevision] = useState(0)
  const harness = data.harness ?? 'pi'
  const [connection, setConnection] = useState(harness)
  const executable = executableSetting(data, connection)
  const connected = harnessDisplayName(data, connection)
  const catalog = useHarnessCatalog({ harness: connection, cwd: data.cwd, executable,
    providerRevision: catalogRevision(data, connection), enabled: active && connection !== 'pi' && (connection !== 'acp' || Boolean(executable)), revision })

  async function save(operation) {
    setPending(true)
    setError(null)
    try { await operation() }
    catch (err) { setError(err) }
    finally { setPending(false) }
  }

  const useExecutable = (path) => connection === 'opencode' ? api.setOpenCodePath(path) : api.setHarnessExecutable(connection, path)
  return <div className="harness-settings">
    <div className="settings-choice-row">
      <div><Label htmlFor="default-harness">Default harness</Label><p>Choose what runs new chats.</p></div>
      <HarnessPicker data={data} id="default-harness" label="Default harness" description="Choose what runs new chats."
        value={harness} disabled={pending || !data.root} onValueChange={(id) => save(async () => {
          await api.setHarness(id)
          setConnection(id)
        })} />
    </div>
    <ErrorNotice error={error} />
    <HarnessGrid data={data} label="Harness connections" value={connection} defaultId={harness} disabled={pending}
      onValueChange={(id) => { setConnection(id); setError(null) }} />
    {connection === 'pi' ? <section className="harness-connection surface-panel" aria-label="Pi connection">
      <div className="harness-connection-row"><div className="connection-title"><HarnessMark id="pi" />
        <div><h2>Pi</h2><p>Configure the model providers used by the built-in agent.</p></div>
      </div><Button type="button" variant="outline" size="sm" onClick={openProviders}>Manage providers</Button></div>
    </section> : <section key={connection} className="harness-connection surface-panel" aria-label={connected + ' connection'}>
      <div className="harness-connection-row connection-header">
        <div className="connection-title"><HarnessMark id={connection} /><div><h2>{connected}</h2>
          <div className="harness-status" role="status">
            {catalog.error ? <CircleAlert size={14} /> : catalog.executable ? <Check size={14} /> : null}
            {catalog.loading ? 'Checking installation…' : catalog.error ? 'Connection unavailable'
              : catalog.version ? 'Connected · ' + catalog.version
              : catalog.executable ? 'Executable found' : 'Choose an executable to connect'}
          </div>
        </div></div>
        <Button variant="outline" size="sm" disabled={pending || catalog.loading || !data.root || (connection === 'acp' && !executable)} onClick={() => save(async () => {
          if (connection === 'opencode') await api.reconnectOpenCode()
          setRevision((value) => value + 1)
        })}><RefreshCw /> Refresh</Button>
      </div>
      <ErrorNotice error={catalog.error} />
      <div className="harness-connection-row harness-executable">
        <div><strong>Executable</strong><p title={executable ?? catalog.executable}>{executable ?? catalog.executable ?? (connection === 'acp' ? 'No executable selected' : 'Detect automatically')}</p></div>
        <div className="harness-buttons">
          {executable && <Button variant="ghost" size="sm" disabled={pending} onClick={() => save(() => useExecutable(null))}>{connection === 'acp' ? 'Disconnect' : 'Auto-detect'}</Button>}
          <Button variant="outline" size="sm" disabled={pending || !data.root} onClick={() => save(async () => {
            const next = await (connection === 'opencode' ? api.pickOpenCode() : api.pickHarnessExecutable(connection))
            if (next) await useExecutable(next)
          })}>Choose executable</Button>
        </div>
      </div>
      {connection === 'acp' ? <CustomAcpSettings saved={data.customAcp} save={save} pending={pending} />
        : <p>Run <code>{setupCommand[connection]}</code> in your terminal to set up this harness's account and providers.</p>}
      {['codex', 'claude'].includes(connection) && <NativeModels key={connection} harness={connection} models={data.harnessModels?.[connection] ?? []} save={save} pending={pending} />}
    </section>}
  </div>
}
