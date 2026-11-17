const sansFallback = 'system-ui, sans-serif'
const serifFallback = 'Georgia, serif'
const monoFallback = 'ui-monospace, Menlo, Consolas, monospace'

function font(label, family, fallback, load) {
  return { label, family: '"' + family + '", ' + fallback, load }
}

const fonts = {
  inter: font('Inter', 'Inter Variable', sansFallback),
  geist: font('Geist', 'Geist Variable', sansFallback),
  'dm-sans': font('DM Sans', 'DM Sans Variable', sansFallback, () => import('@fontsource-variable/dm-sans')),
  'instrument-sans': font('Instrument Sans', 'Instrument Sans Variable', sansFallback, () => import('@fontsource-variable/instrument-sans')),
  'work-sans': font('Work Sans', 'Work Sans Variable', sansFallback, () => import('@fontsource-variable/work-sans')),
  'rethink-sans': font('Rethink Sans', 'Rethink Sans Variable', sansFallback, () => import('@fontsource-variable/rethink-sans')),
  'source-sans': font('Source Sans 3', 'Source Sans 3 Variable', sansFallback, () => import('@fontsource-variable/source-sans-3')),
  nunito: font('Nunito', 'Nunito Variable', sansFallback, () => import('@fontsource-variable/nunito')),
  lexend: font('Lexend', 'Lexend Variable', sansFallback, () => import('@fontsource-variable/lexend')),
  atkinson: font('Atkinson Hyperlegible Next', 'Atkinson Hyperlegible Next Variable', sansFallback, () => import('@fontsource-variable/atkinson-hyperlegible-next')),
  bricolage: font('Bricolage Grotesque', 'Bricolage Grotesque Variable', sansFallback, () => import('@fontsource-variable/bricolage-grotesque')),
  barlow: font('Barlow', 'Barlow', sansFallback, () => Promise.all([import('@fontsource/barlow/400.css'), import('@fontsource/barlow/500.css'), import('@fontsource/barlow/600.css')])),
  'playfair-display': font('Playfair Display', 'Playfair Display Variable', serifFallback, () => import('@fontsource-variable/playfair-display')),
  'crimson-text': font('Crimson Text', 'Crimson Text', serifFallback, () => import('@fontsource/crimson-text/400.css')),
  'instrument-serif': font('Instrument Serif', 'Instrument Serif', serifFallback, () => import('@fontsource/instrument-serif/400.css')),
  'geist-mono': font('Geist Mono', 'Geist Mono Variable', monoFallback, () => import('@fontsource-variable/geist-mono')),
  'martian-mono': font('Martian Mono', 'Martian Mono Variable', monoFallback, () => import('@fontsource-variable/martian-mono')),
  'ibm-plex-mono': font('IBM Plex Mono', 'IBM Plex Mono', monoFallback, () => import('@fontsource/ibm-plex-mono/400.css')),
  'space-mono': font('Space Mono', 'Space Mono', monoFallback, () => import('@fontsource/space-mono/400.css')),
  'courier-prime': font('Courier Prime', 'Courier Prime', monoFallback, () => import('@fontsource/courier-prime/400.css')),
  system: { label: 'System Sans', family: sansFallback },
  rounded: { label: 'System Rounded', family: '"SF Pro Rounded", ui-rounded, ' + sansFallback },
  serif: { label: 'System Serif', family: '"New York", ' + serifFallback },
  mono: { label: 'System Mono', family: monoFallback },
}

const mono = ['mono', 'geist-mono', 'ibm-plex-mono', 'martian-mono', 'space-mono', 'courier-prime']
export const FONT_GROUPS = [
  ['Sans serif', ['inter', 'geist', 'dm-sans', 'instrument-sans', 'work-sans', 'rethink-sans', 'source-sans',
    'nunito', 'lexend', 'atkinson', 'bricolage', 'barlow', 'system', 'rounded']],
  ['Serif', ['playfair-display', 'crimson-text', 'instrument-serif', 'serif']],
  ['Monospace', mono],
]
export const EDITOR_FONTS = [['Monospace', mono]]
export const hasFont = (id) => Object.hasOwn(fonts, id)
export const hasEditorFont = (id) => mono.includes(id)
export const fontOptions = (ids) => ids.map((id) => [id, fonts[id].label])
export const fontFamily = (id) => hasFont(id) ? fonts[id].family : sansFallback

const loading = new Map()
export function loadFont(id) {
  const load = hasFont(id) && fonts[id].load
  if (!load) return
  if (!loading.has(id)) loading.set(id, load().catch(() => { loading.delete(id) }))
  return loading.get(id)
}
