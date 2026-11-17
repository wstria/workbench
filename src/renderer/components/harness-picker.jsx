import { Aperture, CircuitBoard, Braces, Check, Code2, Plug, Terminal, Workflow } from 'lucide-react'
import { CatalogDialog } from '@/components/catalog-dialog'
import { harnessDisplayName, harnessOptions } from '@/lib/harnesses'

const engines = {
  pi: [Aperture, 'Workbench’s built-in agent. Connect providers and models in Settings.', '145'],
  opencode: [Code2, 'Use the models and accounts configured in your local OpenCode.', '204'],
  hermes: [Workflow, 'Run the local Hermes agent through its ACP connection.', '39'],
  codex: [Terminal, 'Use your local Codex installation and its signed-in account.', '154'],
  claude: [Braces, 'Use Claude Code and the models configured for its account.', '24'],
  acp: [Plug, 'Connect an agent that supports the Agent Client Protocol.', '282'],
}

export function HarnessMark({ id }) {
  const [Icon, , hue] = engines[id] ?? engines.acp
  return <span className="catalog-mark" style={{ '--mark-hue': hue }}><Icon size={18} aria-hidden="true" /></span>
}

export function HarnessGrid({ data, value, onValueChange, label, defaultId, disabled }) {
  return <div className="harness-grid" role="group" aria-label={label}>
    {harnessOptions.map(([id]) => <button type="button" className="harness-card" key={id}
      aria-pressed={value === id} disabled={disabled} onClick={() => onValueChange(id)}>
      <HarnessMark id={id} />
      <span className="harness-card-copy">
        <span className="harness-card-name"><strong>{harnessDisplayName(data, id)}</strong>{id === defaultId && <small>Default</small>}</span>
        <span>{engines[id][1]}</span>
      </span>
      {value === id && <Check className="catalog-selected" size={16} aria-hidden="true" />}
    </button>)}
  </div>
}

export function HarnessPicker({ data, value, onValueChange, label = 'Harness', description = 'Choose the runtime that runs your chat.', className, disabled, id }) {
  return <CatalogDialog title="Choose a harness" description={description} name={harnessDisplayName(data, value)}
    label={label} className={className} disabled={disabled} id={id} icon={CircuitBoard}>
    {(close) => <HarnessGrid data={data} value={value} label="Available harnesses" defaultId={data.harness} onValueChange={(id) => {
      onValueChange(id)
      close()
    }} />}
  </CatalogDialog>
}
