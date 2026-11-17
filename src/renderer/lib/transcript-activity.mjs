const kinds = {
  read: { kind: 'read', done: 'Read', running: 'Reading', summary: 'Read files', file: true },
  grep: { kind: 'search', done: 'Searched for', running: 'Searching for', summary: 'Searched files' },
  find: { kind: 'search', done: 'Looked for', running: 'Looking for', summary: 'Searched files' },
  ls: { kind: 'read', done: 'Listed', running: 'Listing', summary: 'Listed folders' },
  bash: { kind: 'terminal', done: 'Ran', running: 'Running', summary: 'Ran commands' },
  powershell: { kind: 'terminal', done: 'Ran', running: 'Running', summary: 'Ran commands' },
  edit: { kind: 'edit', done: 'Edited', running: 'Editing', summary: 'Edited files', file: true },
  write: { kind: 'edit', done: 'Wrote', running: 'Writing', summary: 'Wrote files', file: true },
  web_search: { kind: 'web', done: 'Searched the web for', running: 'Searching the web for', summary: 'Searched the web' },
  websearch: { kind: 'web', done: 'Searched the web for', running: 'Searching the web for', summary: 'Searched the web' },
  web_fetch: { kind: 'web', done: 'Read', running: 'Reading', summary: 'Read web pages' },
  webfetch: { kind: 'web', done: 'Read', running: 'Reading', summary: 'Read web pages' },
}

const sessionActions = {
  spawn: { done: 'Started session', running: 'Starting session' },
  list: { done: 'Checked linked sessions', running: 'Checking linked sessions' },
  read: { done: 'Read a linked session', running: 'Reading a linked session' },
  update: { done: 'Shared a team update', running: 'Sharing a team update' },
}

export function toolActivity(entry) {
  if (entry.tool === 'workbench_team') {
    const action = Object.hasOwn(sessionActions, entry.action) ? sessionActions[entry.action] : {
      done: 'Coordinated linked sessions', running: 'Coordinating linked sessions',
    }
    return { kind: 'team', summary: 'Coordinated linked sessions',
      label: entry.status === 'running' ? action.running : entry.status === 'failed' && entry.action === 'spawn' ? 'Could not start session' : action.done,
      target: entry.action === 'spawn' ? entry.title : '' }
  }
  const name = typeof entry.tool === 'string' ? entry.tool.toLowerCase() : ''
  const action = Object.hasOwn(kinds, name) ? kinds[name] : null
  const label = entry.status === 'running' ? action?.running : action?.done
  return action ? { ...action, label: entry.title ? label : label.replace(/ for$/, ''), target: entry.title }
    : { kind: 'tool', label: entry.status === 'running' ? 'Using ' + (entry.tool || 'tool') : entry.tool || 'Tool',
      summary: 'Used tools', target: entry.title }
}

export function groupTranscript(entries) {
  const rows = []
  let group
  for (const entry of entries) {
    if (entry.type === 'status' && (entry.approval === 'allowed' || /^Allowed [\w-]+ · /.test(entry.text))) continue
    if (entry.type === 'tool' && (!entry.status || entry.status === 'done') &&
      !entry.diff && !entry.sessionLink && entry.tool !== 'workbench_team') {
      if (!group) {
        group = { id: entry.id, type: 'tool-group', tools: [] }
        rows.push(group)
      }
      group.tools.push(entry)
    } else {
      group = undefined
      rows.push(entry)
    }
  }
  return rows
}

export function fileDisplayName(file) {
  return file?.split(/[\\/]/).filter(Boolean).at(-1)
}

export function diffLines(value) {
  const lines = value.split('\n')
  if (!lines.at(-1)) lines.pop()
  let oldLine, oldRemaining = 0
  let newLine, newRemaining = 0
  const unified = lines.some((line) => /^@@ -\d/.test(line))
  return lines.flatMap((line) => {
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(line)
    if (range) {
      oldLine = Number(range[1])
      oldRemaining = Number(range[2] ?? 1)
      newLine = Number(range[3])
      newRemaining = Number(range[4] ?? 1)
      return [{ text: line, change: 'context' }]
    }
    if (unified) {
      if (line.startsWith('\\')) return [{ text: line, change: 'context' }]
      if (!oldRemaining && !newRemaining) return []
      if (line.startsWith('+') && newRemaining > 0) {
        newRemaining--
        return [{ text: line.slice(1), number: newLine++, change: 'add' }]
      }
      if (line.startsWith('-') && oldRemaining > 0) {
        oldRemaining--
        return [{ text: line.slice(1), number: oldLine++, change: 'remove' }]
      }
      if (line.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
        oldRemaining--
        newRemaining--
        oldLine++
        return [{ text: line.slice(1), number: newLine++ }]
      }
      return []
    }
    const compact = /^([+ -])\s*(\d+) (.*)$/.exec(line)
    if (compact) return [{ text: compact[3], number: Number(compact[2]),
      change: compact[1] === '+' ? 'add' : compact[1] === '-' ? 'remove' : undefined }]
    const change = /^\+(?!\+\+)/.test(line) ? 'add' : /^-(?!--)/.test(line) ? 'remove' : undefined
    return [{ text: change ? line.slice(1) : line, change }]
  })
}
