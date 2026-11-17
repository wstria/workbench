export const COLOR_GROUPS = [
  ['Surfaces', [
    ['--shell-bg', 'Window'], ['--shell-chrome', 'Tab bar'], ['--shell-rail', 'Side rail'],
    ['--shell-sidebar', 'Sidebar'], ['--shell-stage', 'Editor surface'],
  ]],
  ['Controls', [
    ['--shell-tab', 'Control surface'], ['--shell-tab-hover', 'Hover'], ['--shell-tab-active', 'Selected tab'],
    ['--shell-line', 'Divider'], ['--shell-line-bright', 'Control border'],
  ]],
  ['Text and accent', [
    ['--shell-text', 'Text'], ['--shell-muted', 'Muted text'], ['accent', 'Accent'],
  ]],
]

const colorKeys = COLOR_GROUPS.flatMap(([, colors]) => colors.map(([key]) => key)).filter((key) => key !== 'accent')

function palette(name, scheme, accent, values) {
  const [background, sidebar, stage, control, hover, active, border, input, text, muted] = values
  return { name, scheme, accent, colors: {
    '--shell-bg': background, '--shell-chrome': background, '--shell-rail': background,
    '--shell-sidebar': sidebar, '--shell-stage': stage, '--shell-tab': control, '--shell-tab-hover': hover,
    '--shell-tab-active': active, '--shell-line': border, '--shell-line-bright': input, '--shell-text': text, '--shell-muted': muted,
  } }
}

export const PRESETS = {
  minimal: {
    name: 'Minimal', scheme: 'dark', accent: '#10a37f',
    colors: {
      '--shell-bg': '#000000', '--shell-chrome': '#000000', '--shell-rail': '#000000',
      '--shell-sidebar': '#000000', '--shell-stage': '#000000', '--shell-tab': '#161618',
      '--shell-tab-hover': '#1d1d20', '--shell-tab-active': '#242428', '--shell-line': '#222225',
      '--shell-line-bright': '#33333a', '--shell-text': '#ececec', '--shell-muted': '#a1a1aa',
    }
  },
  blackout: {
    name: 'Blackout', scheme: 'dark', accent: '#72b388',
    colors: {
      '--shell-bg': '#020302', '--shell-chrome': '#050605', '--shell-rail': '#030403',
      '--shell-sidebar': '#080a08', '--shell-stage': '#070807', '--shell-tab': '#0d100d',
      '--shell-tab-hover': '#121512', '--shell-tab-active': '#151915', '--shell-line': '#1d221e',
      '--shell-line-bright': '#283028', '--shell-text': '#eff2ee', '--shell-muted': '#8e978e',
    }
  },
  graphite: {
    name: 'Graphite', scheme: 'dark', accent: '#86a9ee',
    colors: {
      '--shell-bg': '#121315', '--shell-chrome': '#17181b', '--shell-rail': '#141518',
      '--shell-sidebar': '#1b1d21', '--shell-stage': '#161719', '--shell-tab': '#212329',
      '--shell-tab-hover': '#282b31', '--shell-tab-active': '#30333a', '--shell-line': '#2b2e34',
      '--shell-line-bright': '#3a3e45', '--shell-text': '#edeef1', '--shell-muted': '#9aa0ab',
    }
  },
  midnight: {
    name: 'Midnight', scheme: 'dark', accent: '#a6a9f3',
    colors: {
      '--shell-bg': '#0a0d14', '--shell-chrome': '#0e121b', '--shell-rail': '#0b0e16',
      '--shell-sidebar': '#121829', '--shell-stage': '#0e131e', '--shell-tab': '#182033',
      '--shell-tab-hover': '#1f283f', '--shell-tab-active': '#27324d', '--shell-line': '#263048',
      '--shell-line-bright': '#354160', '--shell-text': '#e9edf6', '--shell-muted': '#8893a8',
    }
  },
  paper: {
    name: 'Paper', scheme: 'light', accent: '#0d765e',
    colors: {
      '--shell-bg': '#f4f4f5', '--shell-chrome': '#f4f4f5', '--shell-rail': '#f4f4f5',
      '--shell-sidebar': '#fafafa', '--shell-stage': '#ffffff', '--shell-tab': '#f4f4f5',
      '--shell-tab-hover': '#eeeef0', '--shell-tab-active': '#e5e5e8', '--shell-line': '#d4d4d8',
      '--shell-line-bright': '#c7c7ce', '--shell-text': '#18181b', '--shell-muted': '#52525b',
    }
  },
  dusk: palette('Dusk', 'dark', '#c6a3ed', ['#17131e', '#1c1726', '#201b2b', '#2b2338', '#342843', '#403052', '#372d42', '#5e4d6e', '#f0e8fa', '#b5a7c6']),
  ocean: palette('Ocean', 'dark', '#67cde6', ['#0b1720', '#10212c', '#0f1c26', '#172c3c', '#20394a', '#28485b', '#233847', '#3e5a6a', '#deeff8', '#9ab3c1']),
  forest: palette('Forest', 'dark', '#a8c986', ['#101812', '#152218', '#142017', '#1e3022', '#263b2a', '#314b32', '#2b3d2d', '#485e48', '#e6efe2', '#a5b9a1']),
  mocha: palette('Mocha', 'dark', '#e9a782', ['#1a1514', '#211916', '#241b18', '#2f231f', '#392a25', '#4a342c', '#392d29', '#644d42', '#f6eae3', '#c0aaa0']),
  slate: palette('Slate', 'dark', '#91b8d4', ['#171c23', '#202730', '#1d232b', '#262f3a', '#303d4a', '#394958', '#323c49', '#4b5969', '#e8eef5', '#aab7c6']),
  porcelain: palette('Porcelain', 'light', '#2259a9', ['#edf2f9', '#f2f6fc', '#fbfdff', '#edf2fa', '#e4edf8', '#dae6f6', '#d1ddeb', '#a8b9d1', '#15253c', '#4d6078']),
  sand: palette('Sand', 'light', '#965025', ['#eee7dc', '#f3ece1', '#fcf8f1', '#f3ebdf', '#eae0d1', '#e1d4c3', '#ddd1c1', '#baaa98', '#362b24', '#655347']),
  lilac: palette('Lilac', 'light', '#6d419c', ['#f0eaf7', '#f5effa', '#fcf9ff', '#f2ebfa', '#e9def5', '#e1d1ef', '#dfd2ea', '#bda8d0', '#30263b', '#655471']),
  mint: palette('Mint', 'light', '#176850', ['#e8f1ec', '#eff7f1', '#f9fdfa', '#ecf5ee', '#dfede4', '#d4e8da', '#cfdfd5', '#a7c0b0', '#183329', '#4b6659']),
}

export function validHex(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

export function normalizeCustomThemes(value) {
  if (!Array.isArray(value)) return []
  const themes = new Map()
  for (const item of value) {
    if (typeof item?.id !== 'string' || !/^custom-[a-z0-9-]{1,64}$/.test(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || !['light', 'dark'].includes(item.scheme)) continue
    const base = item.scheme === 'light' ? PRESETS.paper : PRESETS.minimal
    const colors = Object.fromEntries(colorKeys.map((key) => [
      key, validHex(item.colors?.[key]) ? item.colors[key] : base.colors[key],
    ]))
    themes.set(item.id, { id: item.id, name: item.name.trim().slice(0, 60), scheme: item.scheme,
      accent: validHex(item.accent) ? item.accent : base.accent, colors })
  }
  return [...themes.values()]
}

export function resolvePalette(theme) {
  const custom = theme.customThemes?.find(({ id }) => id === theme.preset)
  const selected = custom ?? (Object.hasOwn(PRESETS, theme.preset) ? PRESETS[theme.preset] : PRESETS.minimal)
  return { ...selected, accent: validHex(theme.accent) ? theme.accent : selected.accent }
}

export function accentInk(hex) {
  const [red, green, blue] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
  })
  return .2126 * red + .7152 * green + .0722 * blue > .179 ? '#000000' : '#ffffff'
}
