import { useId, useState } from 'react'
import { Check, Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { EDITOR_FONTS, FONT_GROUPS, fontOptions } from '@/lib/fonts'
import { accentInk, COLOR_GROUPS, PRESETS, resolvePalette, validHex } from '@/lib/palettes.mjs'
import './appearance-settings.css'

function Sample({ palette, large = false }) {
  return <span aria-hidden="true" className={'theme-sample' + (large ? ' theme-sample-large' : '')}
    style={{ ...palette.colors, '--theme-accent': palette.accent, '--sample-ink': accentInk(palette.accent) }}>
    <span className="theme-sample-bar"><span />{large && <span />}<span /></span>
    <span className="theme-sample-sidebar"><span /><span /><span /></span>
    <span className="theme-sample-editor">
      {large ? <><strong>Editor preview</strong><span>const theme = 'custom'</span><span>Appearance</span></>
        : <><span /><span /><span /></>}
    </span>
  </span>
}

function ThemeCard({ selected, palette, choose }) {
  return <Button type="button" variant="outline" className="preset" aria-pressed={selected} onClick={choose}>
    <Sample palette={palette} />
    <span className="preset-label"><span className="truncate">{palette.name}</span>{selected && <Check size={14} aria-hidden="true" />}</span>
  </Button>
}

function ColorField({ label, value, change }) {
  const id = useId()
  const [draft, setDraft] = useState(null)
  const invalid = draft !== null && !validHex(draft)
  return <div className="theme-color-field">
    <Label htmlFor={id}>{label}</Label>
    <div>
      <Input type="color" className="accent-picker" aria-label={'Pick ' + label.toLowerCase()} value={value}
        onChange={(event) => { setDraft(null); change(event.target.value) }} />
      <Input id={id} value={draft ?? value} className="theme-hex-input" maxLength={7} aria-invalid={invalid || undefined}
        pattern="#[0-9a-fA-F]{6}" onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (validHex(next)) change(next)
        }} onBlur={() => setDraft(null)} />
    </div>
  </div>
}

function ThemeEditor({ initial, save, cancel }) {
  const [draft, setDraft] = useState(initial)
  return <form className="theme-editor" onSubmit={(event) => {
    event.preventDefault()
    const name = draft.name.trim()
    if (name) save({ ...draft, name })
  }}>
    <div className="theme-editor-fields">
      <div><Label htmlFor="theme-name">Theme name</Label>
        <Input id="theme-name" value={draft.name} maxLength={60} autoFocus required
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></div>
      <div><Label htmlFor="theme-appearance">Appearance</Label>
        <Select value={draft.scheme} onValueChange={(scheme) => setDraft((current) => ({ ...current, scheme }))}>
          <SelectTrigger id="theme-appearance"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="dark">Dark</SelectItem><SelectItem value="light">Light</SelectItem></SelectContent>
        </Select></div>
    </div>
    <Sample palette={draft} large />
    {COLOR_GROUPS.map(([name, colors]) => <fieldset key={name}>
      <legend>{name}</legend>
      <div className="theme-color-grid">
        {colors.map(([key, label]) => <ColorField key={key} label={label}
          value={key === 'accent' ? draft.accent : draft.colors[key]}
          change={(value) => setDraft((current) => key === 'accent'
            ? { ...current, accent: value } : { ...current, colors: { ...current.colors, [key]: value } })} />)}
      </div>
    </fieldset>)}
    <div className="work-actions">
      <Button type="submit" variant="secondary" disabled={!draft.name.trim()}>Save and apply</Button>
      <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
    </div>
  </form>
}

export function ThemeSettings({ theme, setTheme }) {
  const [draft, setDraft] = useState(null)

  function choose(preset) {
    setTheme((current) => ({ ...current, preset, accent: null, accentOverride: false }))
  }

  function create(palette = resolvePalette(theme), name = '') {
    setDraft({ ...palette, id: 'custom-' + crypto.randomUUID(), name })
  }

  function save(updated) {
    setTheme((current) => {
      const exists = current.customThemes.some(({ id }) => id === updated.id)
      const customThemes = exists ? current.customThemes.map((item) => item.id === updated.id ? updated : item) : [...current.customThemes, updated]
      return { ...current, customThemes, preset: updated.id, accent: null, accentOverride: false }
    })
    setDraft(null)
  }

  function remove(id) {
    setTheme((current) => ({
      ...current, customThemes: current.customThemes.filter((item) => item.id !== id),
      ...(current.preset === id && { preset: 'minimal', accent: null, accentOverride: false }),
    }))
  }

  if (draft) return <ThemeEditor initial={draft} save={save} cancel={() => setDraft(null)} />

  return <div className="appearance-settings">
    <div className="appearance-heading">
      <h2>Custom themes</h2>
      <Button type="button" size="sm" variant="secondary" onClick={() => create()}><Plus /> Create theme</Button>
    </div>
    {theme.customThemes.length > 0 && <div className="preset-grid">
      {theme.customThemes.map((palette) => <div key={palette.id} className="custom-theme-card">
        <ThemeCard palette={palette} selected={theme.preset === palette.id} choose={() => choose(palette.id)} />
        <div className="custom-theme-actions">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={'Edit ' + palette.name} onClick={() => setDraft(palette)}><Pencil /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={'Duplicate ' + palette.name}
            onClick={() => create(palette, (palette.name.slice(0, 55) + ' copy'))}><Copy /></Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={'Delete ' + palette.name} onClick={() => remove(palette.id)}><Trash2 /></Button>
        </div>
      </div>)}
    </div>}
    <div className="appearance-heading"><h2>Built-in themes</h2></div>
    <div className="preset-grid">
      {Object.entries(PRESETS).map(([id, palette]) => <ThemeCard key={id} palette={palette}
        selected={theme.preset === id} choose={() => choose(id)} />)}
    </div>
  </div>
}

export function AccentSettings({ theme, setTheme }) {
  const { accent } = resolvePalette(theme)
  return <div className="appearance-settings">
    <ColorField label="Accent color" value={accent}
      change={(value) => setTheme((current) => ({ ...current, accent: value, accentOverride: true }))} />
    {theme.accentOverride && <div className="work-actions">
      <Button type="button" variant="ghost" size="sm" onClick={() => setTheme((current) => ({ ...current, accent: null, accentOverride: false }))}>Use theme accent</Button>
    </div>}
  </div>
}

function FontSelect({ label, groups, value, change }) {
  const id = useId()
  return <div className="setting-row">
    <Label htmlFor={id}>{label}</Label>
    <Select value={value} onValueChange={change}>
      <SelectTrigger id={id} className="font-select"><SelectValue /></SelectTrigger>
      <SelectContent position="popper">
        {groups.map(([group, options]) => <SelectGroup key={group}>
          <SelectLabel>{group}</SelectLabel>
          {fontOptions(options).map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
        </SelectGroup>)}
      </SelectContent>
    </Select>
  </div>
}

function FontSize({ label, value, max, change }) {
  const id = useId()
  return <div className="setting-row">
    <div className="flex items-baseline gap-2"><Label id={id}>{label}</Label><span className="text-muted-foreground tabular-nums">{value}px</span></div>
    <Slider aria-labelledby={id} value={[value]} onValueChange={([next]) => change(next)} min={11} max={max} step={1} className="setting-slider" />
  </div>
}

export function TypographySettings({ theme, setTheme }) {
  const change = (key) => (value) => setTheme((current) => ({ ...current, [key]: value }))
  return <>
    <FontSelect label="Interface font" groups={FONT_GROUPS} value={theme.font} change={change('font')} />
    <FontSize label="Interface size" max={20} value={theme.fontSize} change={change('fontSize')} />
    <FontSelect label="Editor font" groups={EDITOR_FONTS} value={theme.editorFont} change={change('editorFont')} />
    <FontSize label="Editor size" max={24} value={theme.editorFontSize} change={change('editorFontSize')} />
    <div className="typography-preview">
      <p>Preview the interface and editor fonts.</p>
      <pre><code>{'const workspace = "Workbench"\n// 0 O  1 l I'}</code></pre>
    </div>
  </>
}
