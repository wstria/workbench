const previewCount = 12
const maxCharacters = 4 * 1024 * 1024

function expression(search, sensitive) {
  return new RegExp(search.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&'), sensitive ? 'gu' : 'giu')
}

export function inspectMatches(text, search, replacement = '', sensitive = false) {
  let count = 0
  let line = 1
  let lineStart = 0
  let size = text.length
  const preview = []
  if (!search || search.length > 256) return { preview, count, canReplace: false }
  const matches = expression(search, sensitive)
  for (let match = matches.exec(text); match; match = matches.exec(text)) {
    count += 1
    size += replacement.length - match[0].length
    if (preview.length >= previewCount) continue
    for (let next = text.indexOf('\n', lineStart); next >= 0 && next < match.index; next = text.indexOf('\n', lineStart)) {
      line += 1
      lineStart = next + 1
    }
    const from = Math.max(lineStart, match.index - 50)
    const end = match.index + match[0].length
    const newline = text.indexOf('\n', end)
    const to = Math.min(newline < 0 ? text.length : newline, end + 50)
    preview.push({ index: match.index, line, before: text.slice(from, match.index), match: match[0], after: text.slice(end, to) })
  }
  return { preview, count, canReplace: count > 0 && size <= maxCharacters }
}

export function replaceMatches(text, search, replacement, sensitive) {
  if (!search || search.length > 256) return text
  return text.replace(expression(search, sensitive), () => replacement)
}
