import { BrowserSettings } from '@/components/browser-settings'
import { Button } from '@/components/ui/button'
import { HarnessSettings } from '@/components/harness-settings'
import { ModelSettings, PermissionSettings } from '@/components/model-settings'
import { MemorySettings, ProfileSettings, WorkbenchPreferences } from '@/components/personal-settings'
import { RoutingSettings, UsageSettings } from '@/components/usage-settings'
import { ProviderSettings } from '@/components/provider-settings'
import { ErrorNotice, Page } from '@/components/workbench-ui'
import { lazy, Suspense, useState } from 'react'
import { THEME_DEFAULTS } from '@/lib/theme'
import { AccentSettings, ThemeSettings, TypographySettings } from '@/components/appearance-settings'

import { SETTINGS_SECTIONS } from '@/lib/settings-sections'

const KnowledgeGraph = lazy(() => import('@/components/knowledge').then(({ KnowledgeGraph }) => ({ default: KnowledgeGraph })))

function MemoryPanel({ openFile, openSource }) {
  const [graph, showGraph] = useState(false)
  return <>
    <div role="group" aria-label="Memory view" className="work-segments memory-view">
      <Button type="button" size="sm" variant="ghost" aria-pressed={!graph} onClick={() => showGraph(false)}>Memories</Button>
      <Button type="button" size="sm" variant="ghost" aria-pressed={graph} onClick={() => showGraph(true)}>Graph</Button>
    </div>
    {graph
      ? <Suspense fallback={<p role="status">Opening knowledge graph…</p>}><KnowledgeGraph mode="memory" openFile={openFile} openSource={openSource} /></Suspense>
      : <MemorySettings />}
  </>
}

function GeneralSettings({ data }) {
  const [error, setError] = useState(null)
  return <div className="settings-list">
    {[['Default workspace', data.cwd, 'workspace'], ['App data', data.root, 'root']].map(([label, path, scope]) => (
      <div key={scope} className="settings-list-row">
        <div className="settings-list-label"><strong>{label}</strong><small title={path}>{path}</small></div>
        <Button type="button" variant="outline" size="sm" disabled={!path} onClick={() => window.workbench.revealData(scope).catch(setError)}>Open folder</Button>
      </div>
    ))}
    <ErrorNotice error={error} />
  </div>
}

export function Settings({ section, theme, data, active, goTo, setTheme, openFile, openSource }) {
  const { group, label, description } = SETTINGS_SECTIONS.find(({ id }) => id === section) ?? SETTINGS_SECTIONS[0]

  return (
    <Page key={section} title={label} description={description} variant="settings">

        {section === 'general' && <GeneralSettings data={data} />}
        {section === 'browser-data' && <BrowserSettings preferences={data.preferences} /> }
        {section === 'preferences' && <WorkbenchPreferences preferences={data.preferences} />}
        {section === 'profile' && <ProfileSettings profile={data.profile} />}
        {section === 'memory' && <MemoryPanel openFile={openFile} openSource={openSource} />}
        {section === 'routing' && <RoutingSettings data={data} active={active} />}
        {section === 'usage' && <UsageSettings data={data} active={active} />}
        {section === 'harness' && <HarnessSettings data={data} active={active} openProviders={() => goTo('providers')} />}
        {section === 'providers' && <ProviderSettings data={data} active={active} openHarness={() => goTo('harness')} />}
        {section === 'models' && <ModelSettings data={data} active={active} openProviders={() => goTo('providers')} openHarness={() => goTo('harness')} />}
        {section === 'permissions' && <PermissionSettings data={data} />}
        {section === 'themes' && <ThemeSettings theme={theme} setTheme={setTheme} />}
        {section === 'colors' && <AccentSettings theme={theme} setTheme={setTheme} />}
        {section === 'typography' && <TypographySettings theme={theme} setTheme={setTheme} />}

        {group === 'Appearance' && <footer className="settings-footer">
          <Button type="button" variant="outline" size="sm" onClick={() => setTheme((current) => ({ ...THEME_DEFAULTS, customThemes: current.customThemes }))}>
            Reset to defaults
          </Button>
        </footer>}
    </Page>
  )
}
