import { useEffect, useState } from 'react'

const empty = { models: [], defaultModel: '', error: null }
const catalogs = new Map()
const pending = new Map()
const cacheDuration = 30_000

function requestCatalog(key, harness, cwd, refresh) {
  if (!pending.has(key)) {
    const request = window.workbench.catalog(harness, cwd, refresh).then((catalog) => {
      const result = { key, ...catalog }
      catalogs.set(key, { result, at: Date.now() })
      if (catalogs.size > 32) catalogs.delete(catalogs.keys().next().value)
      return result
    }).finally(() => pending.delete(key))
    pending.set(key, request)
  }
  return pending.get(key)
}

export function useHarnessCatalog({ harness, cwd, executable, enabled, providerRevision, revision = 0 }) {
  const key = JSON.stringify([harness, cwd, executable, providerRevision, revision])
  const [result, setResult] = useState(null)
  const cached = catalogs.get(key)
  useEffect(() => {
    if (!enabled || !cwd) return
    const entry = catalogs.get(key)
    if (entry && (harness === 'pi' || Date.now() - entry.at < cacheDuration)) {
      setResult(entry.result)
      return
    }
    let current = true
    requestCatalog(key, harness, cwd, revision > 0).then((catalog) => {
      if (current) setResult(catalog)
    }).catch((error) => { if (current) setResult({ key, ...(entry?.result ?? empty), error }) })
    return () => { current = false }
  }, [key, enabled, harness, cwd, revision])
  return result?.key === key ? result : cached?.result ?? { ...empty, loading: Boolean(enabled && cwd) }
}
