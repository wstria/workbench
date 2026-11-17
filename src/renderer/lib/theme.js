import { readStorage } from '@/lib/storage'
import { fontFamily, hasEditorFont, hasFont, loadFont } from '@/lib/fonts'
import { PRESETS, accentInk, normalizeCustomThemes, resolvePalette, validHex } from '@/lib/palettes.mjs'

export const THEME_KEY = 'sidebar-template-theme'
export const THEME_DEFAULTS = {
  preset: 'minimal',
  accent: null,
  accentOverride: false,
  font: 'inter',
  fontRevision: 1,
  fontSize: 14,
  editorFont: 'mono',
  editorFontSize: 14,
  customThemes: [],
}

function fontSize(value, max) {
  return Number.isInteger(value) ? Math.min(max, Math.max(11, value)) : 14
}

export function loadTheme(appearance = readStorage(THEME_KEY)) {
  const saved = appearance && typeof appearance === 'object' && !Array.isArray(appearance) ? appearance : {}
  const customThemes = normalizeCustomThemes(saved.customThemes)
  const preset = Object.hasOwn(PRESETS, saved.preset) || customThemes.some(({ id }) => id === saved.preset) ? saved.preset : THEME_DEFAULTS.preset
  const migrateFont = saved.font === 'geist' && !saved.fontRevision
  const accent = validHex(saved.accent) && (saved.accentOverride || saved.accent !== PRESETS.minimal.accent) ? saved.accent : null
  return { ...THEME_DEFAULTS, customThemes, preset, accent, accentOverride: Boolean(accent),
    font: !migrateFont && hasFont(saved.font) ? saved.font : THEME_DEFAULTS.font,
    fontSize: fontSize(saved.fontSize, 20),
    editorFont: hasEditorFont(saved.editorFont) ? saved.editorFont : THEME_DEFAULTS.editorFont,
    editorFontSize: fontSize(saved.editorFontSize, 24) }
}

export function applyTheme(theme) {
  const root = document.documentElement
  const { scheme, colors, accent } = resolvePalette(theme)
  const background = colors['--shell-bg']
  if (root.dataset.scheme !== scheme || root.style.getPropertyValue('--shell-bg') !== background) {
    root.dataset.scheme = scheme
    root.classList.toggle('dark', scheme === 'dark')
    root.style.colorScheme = scheme
    window.workbench?.setAppearance?.(scheme, background)
  }
  root.dataset.theme = theme.preset
  void loadFont(theme.font)
  void loadFont(theme.editorFont)
  const properties = {
    ...colors, '--theme-accent': accent, '--primary-foreground': accentInk(accent),
    '--font-ui': fontFamily(theme.font),
    '--font-code': fontFamily(theme.editorFont),
    '--font-size': theme.fontSize + 'px',
    '--editor-font-size': theme.editorFontSize + 'px',
  }
  for (const [key, value] of Object.entries(properties)) root.style.setProperty(key, value)
}
