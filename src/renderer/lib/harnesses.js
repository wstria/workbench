export const autoModelId = '@workbench/auto'
export const harnessNames = { pi: 'Pi', opencode: 'OpenCode', hermes: 'Hermes', codex: 'Codex', claude: 'Claude Code', acp: 'Custom ACP' }
export const harnessOptions = Object.entries(harnessNames)

export function executableSetting(data, harness) {
  return harness === 'opencode' ? data.opencodePath : data.harnessExecutables?.[harness]
}

export function catalogRevision(data, harness) {
  return [data.harnessCatalogRevision ?? 0, harness === 'pi' ? data.providerRevision ?? 0 : 0].join(':')
}

export function harnessDisplayName(data, harness) {
  return (harness === 'acp' ? data.customAcp?.name : null) || harnessNames[harness] || harness
}
